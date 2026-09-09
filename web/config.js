// The backend API base the pages talk to. Resolution order (see index.html/report.html):
//   1. the ?api= URL parameter (per-URL override — point a deployed site at a
//      tunnel/local backend without redeploying)
//   2. this value (host-aware): the production base everywhere except local serving —
//      localhost (netlify dev :8888, plain http servers) and file:// fall through to (3)
//   3. http://localhost:8080 — the local-dev default; never reached in production
window.AGENTTETHER_API = ["", "localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  ? ""
  : "https://api.agenttether.cc";
