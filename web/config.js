// The backend API base the pages talk to. Resolution order:
//   1. the ?api= URL parameter (per-URL override — point a deployed site at a
//      tunnel/local backend without redeploying)
//   2. this value (set it for the hosted deployment):
//        window.AGENTTETHER_API = "https://api.your-domain.xyz";
//   3. http://localhost:8080 — the local-dev default; never reached in production
//      once (2) is set. Leave "" while developing locally.
window.AGENTTETHER_API = "";
