import * as OperationTypes from "./OperationTypes";
import * as t from "@babel/types";
import {
  createOperation,
  ignoredArrayExpression,
  ignoredStringLiteral,
  getLastOperationTrackingResultCall,
  ignoredNumericLiteral,
  isInIdOfVariableDeclarator,
  isInLeftPartOfAssignmentExpression,
  trackingIdentifierIfExists,
  ignoredCallExpression,
  ignoreNode,
  runIfIdentifierExists,
  createSetMemoValue,
  createGetMemoValue,
  createGetMemoTrackingValue,
  getLastOpValue,
  ignoredIdentifier
} from "./babelPluginHelpers";

function createNode(args, astArgs = null) { }

interface Operations {
  [key: string]: {
    createNode?: any;
    visitor?: any;
    exec?: any;
    arrayArguments?: string[];
    getArgumentsArray?: any
  };
}

const operations: Operations = {
  memberExpression: {
    exec: (args, astArgs, ctx) => {
      var ret;
      var object = args.object[0];
      var objectT = args.object[1];
      var propertyName = args.propName[0];
      ret = object[propertyName];
      ctx.setters.extraArgTrackingValues({
        propertyValue: [
          ret,
          ctx.getObjectPropertyTrackingValue(object, propertyName)
        ]
      });

      ctx.setters.lastMemberExpressionResult([object, objectT]);

      return ret;
    },
    visitor(path) {
      if (isInLeftPartOfAssignmentExpression(path)) {
        return;
      }
      if (path.parent.type === "UpdateExpression") {
        return;
      }

      // todo: dedupe this code
      var property;
      if (path.node.computed === true) {
        property = path.node.property;
      } else {
        if (path.node.property.type === "Identifier") {
          property = t.stringLiteral(path.node.property.name);
          property.loc = path.node.property.loc;
        }
      }

      const op = this.createNode({
        object: [path.node.object, getLastOperationTrackingResultCall],
        propName: [property, getLastOperationTrackingResultCall]
      });

      return op;
    }
  },
  binaryExpression: {
    visitor(path) {
      if (!["+", "-", "/", "*"].includes(path.node.operator)) {
        return;
      }
      return this.createNode(
        {
          left: [path.node.left, getLastOperationTrackingResultCall],
          right: [path.node.right, getLastOperationTrackingResultCall]
        },
        { operator: ignoredStringLiteral(path.node.operator) }
      );
    },
    exec: (args, astArgs, ctx) => {
      var { left, right } = args;
      var ret;
      left = left[0];
      right = right[0];

      var { operator } = astArgs;
      if (operator === "+") {
        ret = left + right;
      } else if (operator === "-") {
        ret = left - right;
      } else if (operator === "*") {
        ret = left * right;
      } else if (operator === "/") {
        ret = left / right;
      } else {
        throw Error("unknown bin exp operator: " + operator);
      }

      return ret;
    }
  },
  callExpression: {
    exec: (args, astArgs, ctx) => {
      var i = 0;
      var arg;
      var fnArgs = [];
      var fnArgValues = [];
      while (true) {
        var argKey = "arg" + i;
        if (!(argKey in args)) {
          break;
        }
        arg = args[argKey];
        fnArgValues.push(arg[0]);
        fnArgs.push(
          new ctx.OperationLog({
            operation: ctx.operationTypes.functionArgument,
            args: {
              value: arg
            },
            astArgs: {},
            result: arg[0]
          })
        );
        i++;
      }

      ctx.setters.argTrackingInfo(fnArgs);

      var fn = args.function[0];
      var object = args.context[0];
      var ret = fn.apply(object, fnArgValues);
      ctx.setters.argTrackingInfo(null);

      ctx.setters.extraArgTrackingValues({
        returnValue: [ret, ctx.getLastOpTrackingResult()] // pick up value from returnStatement
      });

      return ret;
    },
    visitor(path) {
      const { callee } = path.node;

      var isMemberExpressionCall = callee.type === "MemberExpression";

      var args = [];
      path.node.arguments.forEach(arg => {
        args.push(
          ignoredArrayExpression([arg, getLastOperationTrackingResultCall])
        );
      });

      let executionContext;
      let executionContextTrackingValue;
      if (isMemberExpressionCall) {
        executionContext = ignoredCallExpression(
          "getLastMemberExpressionObjectValue",
          []
        );
        executionContextTrackingValue = ignoredCallExpression(
          "getLastMemberExpressionObjectTrackingValue",
          []
        );
      } else {
        executionContext = t.identifier("undefined");
        executionContextTrackingValue = t.nullLiteral();
      }

      var fnArgs = {};
      args.forEach((arg, i) => {
        fnArgs["arg" + i] = arg;
      });

      var call = operations.callExpression.createNode({
        function: [
          path.node.callee,
          isMemberExpressionCall
            ? getLastOperationTrackingResultCall
            : getLastOperationTrackingResultCall
        ],
        context: [executionContext, executionContextTrackingValue],
        ...fnArgs
      });

      // todo: would it be better for perf if I updated existing call
      // instead of using replaceWith?
      return call;
    }
  },
  objectExpression: {
    exec: (args, astArgs, ctx) => {
      var obj = {};
      var methodProperties = {};

      for (var i = 0; i < args.properties.length; i++) {
        var property = args.properties[i];

        var propertyType = property[0][0];
        var propertyKey = property[1][0];

        if (propertyType === "ObjectProperty") {
          var propertyValue = property[2][0];
          var propertyValueT = property[2][1];

          obj[propertyKey] = propertyValue;

          ctx.trackObjectPropertyAssignment(
            obj,
            propertyKey,
            new ctx.OperationLog({
              operation: "objectExpression",
              args: { propertyValue: [propertyValue, propertyValueT] },
              result: propertyValue,
              astArgs: {}
            })
          );
        } else if (propertyType === "ObjectMethod") {
          var propertyKind = property[2][0];
          var fn = property[3][0];
          if (!methodProperties[propertyKey]) {
            methodProperties[propertyKey] = {
              enumerable: true,
              configurable: true
            };
          }
          if (propertyKind === "method") {
            obj[propertyKey] = fn;
          } else {
            methodProperties[propertyKey][propertyKind] = fn;
          }
        }
      }
      Object.defineProperties(obj, methodProperties);

      return obj;
    },
    visitor(path) {
      path.node.properties.forEach(function (prop) {
        if (prop.key.type === "Identifier") {
          var keyLoc = prop.key.loc;
          prop.key = t.stringLiteral(prop.key.name);
          prop.key.loc = keyLoc;
          // move start a bit to left to compensate for there not
          // being quotes in the original "string", since
          // it's just an identifier
          if (prop.key.loc.start.column > 0) {
            prop.key.loc.start.column--;
          }
        }
      });

      var properties = path.node.properties.map(function (prop) {
        var type = t.stringLiteral(prop.type);
        type.ignore = true;
        if (prop.type === "ObjectMethod") {
          // getters/setters or something like this: obj = {fn(){}}
          var kind = ignoredStringLiteral(prop.kind);
          kind.ignore = true;
          var propArray = ignoredArrayExpression([
            ignoredArrayExpression([type]),
            ignoredArrayExpression([prop.key]),
            ignoredArrayExpression([kind]),
            ignoredArrayExpression([
              t.functionExpression(null, prop.params, prop.body)
            ])
          ]);
          return propArray;
        } else {
          var propArray = ignoredArrayExpression([
            ignoredArrayExpression([type]),
            ignoredArrayExpression([prop.key]),
            ignoredArrayExpression([
              prop.value,
              getLastOperationTrackingResultCall
            ])
          ]);
          return propArray;
        }
      });

      var call = this.createNode({
        properties
      });

      return call;
    }
  },
  stringLiteral: {
    visitor(path) {
      if (path.parent.type === "ObjectProperty") {
        return;
      }
      return this.createNode({
        value: [ignoredStringLiteral(path.node.value), t.nullLiteral()]
      });
    },
    exec: (args, astArgs, ctx) => {
      return args.value[0];
    }
  },
  numericLiteral: {
    visitor(path) {
      if (path.parent.type === "ObjectProperty") {
        return;
      }
      return this.createNode({
        value: [ignoredNumericLiteral(path.node.value), t.nullLiteral()]
      });
    },
    exec: (args, astArgs, ctx) => {
      return args.value[0];
    }
  },
  arrayExpression: {
    arrayArguments: ["elements"],
    exec: (args, astArgs, ctx) => {
      function getArrayArgumentValue(arrayArg) {
        return arrayArg.map(e => e[0]);
      }
      return getArrayArgumentValue(args.elements);
    },
    visitor(path) {
      return this.createNode({
        elements: path.node.elements.map(el =>
          ignoredArrayExpression([el, getLastOperationTrackingResultCall])
        )
      });
    }
  },
  returnStatement: {
    exec: (args, astArgs, ctx) => {
      return args.returnValue[0];
    },
    visitor(path) {
      path.node.argument = this.createNode({
        returnValue: ignoredArrayExpression([
          path.node.argument,
          getLastOperationTrackingResultCall
        ])
      });
    }
  },
  identifier: {
    exec: (args, astArgs, ctx) => {
      return args.value[0];
    },
    visitor(path) {
      if (
        path.parent.type === "FunctionDeclaration" ||
        path.parent.type === "MemberExpression" ||
        path.parent.type === "ObjectProperty" ||
        path.parent.type === "CatchClause" ||
        path.parent.type === "ForInStatement" ||
        path.parent.type === "IfStatement" ||
        path.parent.type === "ForStatement" ||
        path.parent.type === "FunctionExpression" ||
        path.parent.type === "UpdateExpression" ||
        (path.parent.type === "UnaryExpression" &&
          path.parent.operator === "typeof")
      ) {
        return;
      }
      if (
        isInLeftPartOfAssignmentExpression(path) ||
        isInIdOfVariableDeclarator(path)
      ) {
        return;
      }
      if (path.node.name === "globalFn") {
        return;
      }

      path.node.ignore = true;

      return this.createNode({
        value: ignoredArrayExpression([
          path.node,
          trackingIdentifierIfExists(path.node.name)
        ])
      });
    }
  },
  memexpAsLeftAssExp: {},
  assignmentExpression: {
    exec: (args, astArgs, ctx) => {
      var ret;
      const assignmentType = args.type[0];
      const operator = args.operator[0];
      if (assignmentType === "MemberExpression") {
        var obj = args.object[0];
        var propName = args.propertyName[0];
        var objT = args.object[1];
        var propNameT = args.propertyName[1];

        var currentValue = obj[propName];
        var currentValueT = new ctx.OperationLog({
          operation: "memexpAsLeftAssExp",
          args: {
            object: [obj, objT],
            propertyName: [propName, propNameT]
          },
          astArgs: {},
          result: currentValue
        });

        var argument = args.argument[0];
        if (operator === "=") {
          ret = obj[propName] = argument;
        } else if (operator === "+=") {
          ret = obj[propName] = obj[propName] + argument;
        } else {
          throw Error("unknown op " + operator);
        }

        ctx.trackObjectPropertyAssignment(
          obj,
          propName,
          new ctx.OperationLog({
            operation: "assignmentExpression",
            args: {
              currentValue: [currentValue, currentValueT],
              argument: args.argument
            },
            argTrackingValues: [currentValueT, args.argument[1]],
            argNames: ["currentValue", "argument"]
          })
        );
      } else if (assignmentType === "Identifier") {
        ret = args.newValue[0];
      } else {
        throw Error("unknown: " + assignmentType);
      }
      return ret;
    },
    visitor(path) {
      path.node.ignore = true;

      let operationArguments = {
        operator: ignoredArrayExpression([
          ignoredStringLiteral(path.node.operator),
          t.nullLiteral()
        ]),
        type: ignoredArrayExpression([
          ignoredStringLiteral(path.node.left.type),
          t.nullLiteral()
        ])
      };

      let trackingAssignment = null;

      if (path.node.left.type === "MemberExpression") {
        var property;
        if (path.node.left.computed === true) {
          property = path.node.left.property;
        } else {
          property = t.stringLiteral(path.node.left.property.name);
          property.loc = path.node.left.property.loc;
        }

        operationArguments["object"] = [path.node.left.object, t.nullLiteral()];
        operationArguments["propertyName"] = [property, t.nullLiteral()];
        operationArguments["argument"] = [
          path.node.right,
          getLastOperationTrackingResultCall
        ];
      } else if (path.node.left.type === "Identifier") {
        var right = createSetMemoValue(
          "lastAssignmentExpressionArgument",
          path.node.right,
          getLastOperationTrackingResultCall
        );
        path.node.right = right;

        trackingAssignment = runIfIdentifierExists(
          path.node.left.name + "_t",
          ignoreNode(
            t.assignmentExpression(
              "=",
              ignoredIdentifier(path.node.left.name + "_t"),
              getLastOperationTrackingResultCall
            )
          )
        );
        trackingAssignment.ignore = true;

        operationArguments["currentValue"] = ignoredArrayExpression([
          path.node.left,
          getLastOperationTrackingResultCall
        ]);
        (operationArguments["newValue"] = ignoredArrayExpression([
          path.node,
          getLastOperationTrackingResultCall
        ])),
          (operationArguments["argument"] = ignoredArrayExpression([
            createGetMemoValue("lastAssignmentExpressionArgument"),
            createGetMemoTrackingValue("lastAssignmentExpressionArgument")
          ]));
      } else {
        throw Error("unhandled assignmentexpression node.left type");
      }

      const operation = this.createNode(operationArguments);

      if (trackingAssignment) {
        path.replaceWith(
          t.sequenceExpression([operation, trackingAssignment, getLastOpValue])
        );
      } else {
        path.replaceWith(operation);
      }
    }
  }
};

Object.keys(operations).forEach(opName => {
  const operation = operations[opName];
  operation.createNode = function (args, astArgs) {
    return createOperation(OperationTypes[opName], args, astArgs);
  };
  if (!operation.arrayArguments) {
    operation.arrayArguments = [];
  }
  operation.getArgumentsArray = function (operationLog) {
    var operation = this
    function getArgsArray(args) {
      var arrayArguments = []

      if (operation.arrayArguments) {
        arrayArguments = operation.arrayArguments
      }

      var ret = []
      Object.keys(args).forEach(key => {
        if (arrayArguments.includes(key)) {
          args[key].forEach((a, i) => {
            ret.push({ arg: a[1], argName: "element" + i })
          })
        }
        else {
          ret.push({
            arg: args[key][1],
            argName: key,
          })
        }
      })

      return ret
    }

    var arr = getArgsArray(operationLog.args)
    if (operationLog.extraArgs) {
      arr = arr.concat(
        getArgsArray(operationLog.extraArgs)
      )
    }
    return arr
  }
});

export default operations;
