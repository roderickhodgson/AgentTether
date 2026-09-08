// The backend API base the pages talk to. Leave "" for same-origin (local static
// serving against a same-host backend); set it when the tiers are separated:
//   window.AGENTTETHER_API = "https://api.your-domain.xyz";
// The ?api= URL parameter overrides this — handy for pointing a deployed site at a
// local or tunnelled backend without redeploying.
window.AGENTTETHER_API = "";
