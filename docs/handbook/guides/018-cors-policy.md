# CORS Policy

## What it is

CORS (Cross-Origin Resource Sharing) is a security rule that controls which websites can access your API. It's a browser-enforced protection that prevents malicious websites from quietly stealing data from your server.

## What it does

When you visit a webpage, that page's JavaScript can make requests to servers. Without CORS, any website anywhere could secretly request data from any other server — a serious security risk. CORS policies let you explicitly allow only trusted sources (like your own frontend) to access your API. This prevents attackers on unrelated websites from abusing your endpoints.

## How it works

Think of CORS like a bouncer at a club checking a guest list. When your frontend (running on `localhost:5173`) tries to fetch data from your backend API (on `localhost:8000`), the browser checks: *Is localhost:5173 on the allowed list?* If it's on the list, the request goes through. If not, the browser blocks it.

The backend declares this list in response headers, typically allowing:
- Your own frontend domain
- Staging/production URLs
- Maybe a development server during testing

## Example

In Doppia, the backend CORS policy might allow `http://localhost:5173` (frontend dev server) and `https://doppia-staging.example.com` (staging deployment), but reject requests from random websites. See `docs/architecture/security-model.md` for the full policy.

## Related

See `docs/architecture/security-model.md` for Doppia's complete CORS configuration and dev auth bypass.
