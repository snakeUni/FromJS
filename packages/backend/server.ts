import {
  babelPlugin,
  InMemoryLogServer as ServerInterface
} from "@fromjs/core";
import { traverse } from "./src/traverse";
import StackFrameResolver from "./src/StackFrameResolver";
import * as fs from "fs";
import * as prettier from "prettier";
import { startProxy } from "@fromjs/proxy-instrumenter";
import * as Babel from "babel-core";
import * as crypto from "crypto";
import * as path from "path";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as WebSocket from "ws";
import * as http from "http";

export interface BackendOptions {
  bePort: number;
  proxyPort: number;
  onReady: () => void;
}

export default class Backend {
  constructor(options: BackendOptions) {
    var { bePort, proxyPort } = options;

    const app = express();
    app.use(bodyParser.json({ limit: "50mb" }));
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    wss.on("connection", (ws: WebSocket) => {
      ws.send(
        JSON.stringify({
          type: "connected"
        })
      );
    });

    // "Access-Control-Allow-Origin: *" allows any website to send data to local server
    // but that might be bad, so limit access to code generated by Babel plugin
    const accessToken = crypto.randomBytes(32).toString("hex");
    app.verifyToken = function verifyToken(req) {
      if (req.headers.authorization !== accessToken) {
        throw Error("Token invalid:" + req.headers.authorization);
      }
    };

    setupUI(options, app, wss);
    setupBackend(options, app, wss);

    // let domToInspect = null;
    // app.get("/inspectDOM", (req, res) => {
    //   res.end(
    //     JSON.stringify({
    //       domToInspect
    //     })
    //   );
    // });
    // app.post("/inspectDOM", (req, res) => {
    //   app.verifyToken(req);

    //   res.set("Access-Control-Allow-Origin", "*");
    //   res.set(
    //     "Access-Control-Allow-Headers",
    //     "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    //   );

    //   domToInspect = req.body;
    //   res.end("{}");
    // });

    ["/storeLogs", "/inspect", "/inspectDOM"].forEach(path => {
      // todo: don't allow requests from any site
      app.options(path, allowCrossOriginRequests);
    });

    server.listen(bePort, () =>
      console.log("Backend server listening on port " + bePort)
    );

    var proxy;
    startProxy({
      babelPluginOptions: {
        accessToken,
        backendPort: bePort
      },
      port: proxyPort,
      instrumenterFilePath: __dirname + "/instrumentCode.js"
    }).then(p => {
      proxy = p;
      if (options.onReady) {
        options.onReady();
      }
    });
  }
}

function setupUI(options, app, wss) {
  let uiDir = path.resolve(__dirname + "/../node_modules/@fromjs/ui");
  let startPageDir = path.resolve(__dirname + "/../start-page");

  app.get("/", (req, res) => {
    let html = fs.readFileSync(uiDir + "/index.html").toString();
    html = html.replace("BACKEND_PORT_PLACEHOLDER", options.bePort.toString());
    res.send(html);
  });

  app.use(express.static(uiDir));
  app.use("/start", express.static(startPageDir));

  let logToInspect = null;
  app.get("/inspect", (req, res) => {
    res.end(
      JSON.stringify({
        logToInspect
      })
    );
  });
  app.post("/inspect", (req, res) => {
    app.verifyToken(req);
    logToInspect = req.body.logId;
    res.end("{}");

    broadcast(
      wss,
      JSON.stringify({
        type: "inspectOperationLog",
        operationLogId: logToInspect
      })
    );
  });
}

function setupBackend(options, app, wss) {
  const internalServerInterface = new ServerInterface();
  let json;
  try {
    json = fs.readFileSync("logs.json").toString();
  } catch (err) {}
  if (!json) {
    json = "{}";
  }
  internalServerInterface._storedLogs = JSON.parse(json);

  app.post("/storeLogs", (req, res) => {
    app.verifyToken(req);

    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
    );

    req.body.logs.forEach(function(log) {
      internalServerInterface.storeLog(log);
    });

    fs.writeFileSync(
      "logs.json",
      JSON.stringify(internalServerInterface._storedLogs)
    );
    console.log("stored logs", req.body.logs.length);

    res.end(JSON.stringify({ ok: true }));
  });

  app.post("/loadLog", (req, res) => {
    // crude way to first wait for any new logs to be sent through...
    setTimeout(function() {
      // console.log(Object.keys(internalServerInterface._storedLogs));
      console.log(req.body);
      internalServerInterface.loadLog(req.body.id, function(log) {
        res.end(JSON.stringify(log));
      });
    }, 500);
  });

  app.post("/traverse", (req, res) => {
    // crude way to first wait for any new logs to be sent through...
    setTimeout(async function() {
      console.log("traverse", req.body);
      console.time("loading log for traverse");

      // internalServerInterface.loadLog(req.body.logId, async function (log) {
      console.timeEnd("loading log for traverse");
      var steps = await traverse(
        {
          operationLog: req.body.logId,
          charIndex: req.body.charIndex
        },
        [],
        internalServerInterface
      );

      res.end(JSON.stringify({ steps }));
      // });
    }, 500);
  });

  const resolver = new StackFrameResolver({ proxyPort: options.proxyPort });

  app.post("/resolveStackFrame", (req, res) => {
    const frameString = req.body.stackFrameString;

    const operationLog = req.body.operationLog;

    // use loc if available because sourcemaps are buggy...
    if (operationLog.loc) {
      resolver.resolveFrameFromLoc(frameString, operationLog.loc).then(rr => {
        res.end(JSON.stringify(rr));
      });
    } else {
      resolver
        .resolveFrame(frameString)
        .then(rr => {
          res.end(JSON.stringify(rr));
        })
        .catch(err => {
          res.status(500);
          res.end(
            JSON.stringify({
              err
            })
          );
        });
    }
  });

  app.post("/prettify", (req, res) => {
    res.end(JSON.stringify({ code: prettier.format(req.body.code) }));
  });

  app.post("/instrument", (req, res) => {
    const url =
      "http://localhost:11111/eval" +
      Math.floor(Math.random() * 10000000000) +
      ".js";

    const code = req.body.code;

    var babelResult = Babel.transform(code, {
      plugins: [babelPlugin],
      sourceMaps: true
    });

    const evalScriptCode = code;
    // debugger
    proxy.registerEvalScript(url, evalScriptCode, babelResult);

    console.log(babelResult.code.split("* HELPER_FUNCTIONS_END */")[1]);

    const instrumentedCode = babelResult.code + "\n//# sourceURL=" + url;
    res.end(JSON.stringify({ instrumentedCode }));
  });
}

function broadcast(wss, data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function allowCrossOriginRequests(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
  );
  res.end();
}
