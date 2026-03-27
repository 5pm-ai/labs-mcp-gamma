/**
 * Renders a branded HTML interstitial that navigates to the given URL.
 *
 * Replaces bare 302 redirects in the OAuth flow. Some browsers/contexts
 * (e.g. Cursor opening the system browser) fail to follow cross-origin
 * 302 chains or block custom-scheme (cursor://) navigation without a
 * user gesture. An HTML page with JS + meta-refresh + visible link
 * covers all failure modes.
 */
export function renderRedirectPage(url: string, message: string): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="2;url=${escaped}">
<title>5pm MCP</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111;color:#fefefe;font-family:'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{text-align:center;max-width:360px;padding:40px 32px}
.logo{width:32px;height:32px;border-radius:6px;background:#d89998;display:inline-block;margin-bottom:24px}
h1{font-size:18px;font-weight:600;margin-bottom:8px}
p{font-size:14px;color:#808080;margin-bottom:24px;line-height:1.5}
.spinner{width:24px;height:24px;border:2px solid #333;border-top-color:#d89998;border-radius:50%;animation:spin .6s linear infinite;margin:0 auto 24px}
@keyframes spin{to{transform:rotate(360deg)}}
a.btn{display:inline-block;padding:10px 24px;background:#d89998;color:#111;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;transition:opacity .15s}
a.btn:hover{opacity:.85}
.fallback{margin-top:16px;font-size:12px;color:#505050}
.fallback a{color:#808080;text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="logo"></div>
  <div class="spinner"></div>
  <h1>${message}</h1>
  <p>You should be redirected automatically.</p>
  <a class="btn" href="${escaped}" target="_top">Continue</a>
  <div class="fallback">
    <a href="${escaped}" target="_top">Or click here if nothing happens</a>
  </div>
</div>
<script>
try { window.location.replace(${JSON.stringify(url)}); } catch (_) {}
</script>
</body>
</html>`;
}
