const fs = require("fs"), http = require("http");
const s = JSON.parse(fs.readFileSync("deploy/secrets.local.json", "utf8"));
const key = s.ADVISOR_KEY || s.advisorKey || s.advisor_key;
const date = Number(process.argv[2]);
const note = process.argv[3];
const body = JSON.stringify({ key, dates: [date], note });
const req = http.request({ host: "207.148.121.138", port: 8085, path: "/features/complete", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
  let d = ""; res.on("data", c => d += c); res.on("end", () => console.log(date, res.statusCode, d));
});
req.write(body); req.end();
