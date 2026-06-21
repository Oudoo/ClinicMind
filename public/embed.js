/**
 * ClinicMind embed loader.
 *
 * Drop this on any website to mount a tenant's isolated ClinicMind instance:
 *
 *   <div id="clinicmind-root" style="height:800px"></div>
 *   <script src="https://app.clinicmind.example/embed.js"
 *           data-clinicmind-tenant="acme"
 *           data-clinicmind-host="https://app.clinicmind.example"
 *           data-clinicmind-token-endpoint="/api/clinicmind/token"
 *           defer></script>
 *
 * Token flow: the iframe asks for a session token; this loader fetches one from
 * YOUR backend's `token-endpoint` (which calls ClinicMind's POST /api/embed/token
 * with your secret embed key) and relays it to the iframe. The key never touches
 * the browser.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var tenant = script.getAttribute("data-clinicmind-tenant");
  var host = (script.getAttribute("data-clinicmind-host") || "").replace(/\/$/, "");
  var tokenEndpoint = script.getAttribute("data-clinicmind-token-endpoint");
  var mountId = script.getAttribute("data-clinicmind-mount") || "clinicmind-root";

  if (!tenant || !host) {
    console.error("[ClinicMind] data-clinicmind-tenant and data-clinicmind-host are required");
    return;
  }

  var mount = document.getElementById(mountId);
  if (!mount) {
    mount = document.createElement("div");
    mount.id = mountId;
    mount.style.height = "800px";
    script.parentNode.insertBefore(mount, script);
  }

  var iframe = document.createElement("iframe");
  iframe.src = host + "/embed/" + encodeURIComponent(tenant);
  iframe.title = "ClinicMind";
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.setAttribute("allow", "microphone; clipboard-write");
  iframe.setAttribute("loading", "lazy");
  mount.innerHTML = "";
  mount.appendChild(iframe);

  function fetchToken() {
    if (!tokenEndpoint) return Promise.reject(new Error("no token endpoint configured"));
    return fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ tenant: tenant }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("token endpoint returned " + r.status);
        return r.json();
      })
      .then(function (d) {
        return d.token;
      });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== iframe.contentWindow) return;
    var data = event.data || {};
    if (data.type === "clinicmind:request-token") {
      fetchToken()
        .then(function (token) {
          iframe.contentWindow.postMessage({ type: "clinicmind:token", token: token }, host);
        })
        .catch(function (err) {
          console.error("[ClinicMind] failed to obtain embed token:", err);
        });
    } else if (data.type === "clinicmind:resize" && typeof data.height === "number") {
      mount.style.height = data.height + "px";
    }
  });
})();
