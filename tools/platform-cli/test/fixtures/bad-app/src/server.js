// Minimal demo app: answers /healthz and /readyz on $PORT.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  } else {
    res.writeHead(200, { "content-type": "text/plain" }).end("hello");
  }
}).listen(port, "0.0.0.0");
