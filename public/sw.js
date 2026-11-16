const STATIC_CACHE = "kestrel-static-v2";

function isLocalhostOrigin() {
  const host = self.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith("folio-static-") ||
                  key.startsWith("kestrel-static-")) &&
                (isLocalhostOrigin() || key !== STATIC_CACHE),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() =>
        isLocalhostOrigin()
          ? self.registration.unregister()
          : self.clients.claim(),
      ),
  );
});

function isImmutableStaticPath(pathname) {
  return pathname.startsWith("/_next/static/");
}

function isStaticIconAsset(pathname) {
  return (
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg" ||
    pathname === "/icon" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/icon/") ||
    pathname === "/apple-icon"
  );
}

self.addEventListener("fetch", (event) => {
  if (isLocalhostOrigin()) {
    return;
  }

  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept authenticated HTML documents, RSC payloads, or API endpoints.
  if (
    request.mode === "navigate" ||
    url.pathname.startsWith("/api/") ||
    url.searchParams.has("_rsc")
  ) {
    return;
  }

  if (isImmutableStaticPath(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  if (isStaticIconAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      }),
    );
  }
});
