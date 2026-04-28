// =====================================================
// HLS Proxy Worker — Cloudflare Workers
// =====================================================
// Proxia streams M3U8/HLS adicionando CORS e (opcionalmente)
// reescrevendo HTTP -> HTTPS pelo proxy.
//
// USO:
//   GET /?url=<URL_DO_M3U8_OU_TS>
//   GET /?url=<URL>&ref=<REFERER>     (alguns servidores exigem)
//
// EXEMPLO:
//   https://meu-worker.workers.dev/?url=http://servidor.com/stream.m3u8
//
// DEPLOY:
//   1. Crie um Worker em https://dash.cloudflare.com -> Workers & Pages -> Create
//   2. Cole este codigo no editor
//   3. Salve e Deploy
//   4. Copie a URL (algo como https://hls-proxy-XXXX.workers.dev)
//   5. Cole no campo "URL do Worker" no IPTV.lab
// =====================================================

// Lista de origens permitidas (deixe ['*'] para liberar geral, ou
// restrinja ao seu github.io para evitar abuso)
const ALLOWED_ORIGINS = ['*'];
// Exemplo restrito:
// const ALLOWED_ORIGINS = ['https://rmayormartins.github.io'];

// Tamanho maximo de manifest aceito (1 MB e mais que suficiente)
const MAX_MANIFEST_SIZE = 1024 * 1024;

// Headers CORS padrao
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  const allowed = ALLOWED_ORIGINS.includes('*') ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// Detecta se o conteudo e um manifest M3U8
function isManifest(url, contentType) {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('mpegurl') || ct.includes('m3u')) return true;
    if (ct.includes('video/') || ct.includes('audio/')) return false;
  }
  return /\.m3u8?(\?|#|$)/i.test(url);
}

// Reescreve URLs dentro do manifest M3U8 para passarem pelo proxy
function rewriteManifest(manifestText, originalUrl, proxyBase, referer) {
  const base = new URL(originalUrl);
  const lines = manifestText.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Linhas que comecam com # tem URLs em alguns atributos (URI="...")
    if (line.startsWith('#')) {
      // EXT-X-KEY:URI="..."  ou  EXT-X-MAP:URI="..."  etc
      line = line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const abs = new URL(uri, base).href;
        return `URI="${buildProxyUrl(proxyBase, abs, referer)}"`;
      });
      out.push(line);
      continue;
    }

    // Linhas vazias
    if (!line.trim()) { out.push(line); continue; }

    // Linha de URL (pode ser relativa ou absoluta)
    try {
      const abs = new URL(line.trim(), base).href;
      out.push(buildProxyUrl(proxyBase, abs, referer));
    } catch {
      out.push(line);
    }
  }

  return out.join('\n');
}

function buildProxyUrl(proxyBase, targetUrl, referer) {
  const params = new URLSearchParams({ url: targetUrl });
  if (referer) params.set('ref', referer);
  return `${proxyBase}/?${params.toString()}`;
}

// =====================================================
// HANDLER PRINCIPAL
// =====================================================
export default {
  async fetch(request) {
    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const referer = url.searchParams.get('ref') || '';

    // Pagina de info se chamado sem params
    if (!target) {
      return new Response(
        `HLS Proxy Worker
================

Uso: ${url.origin}/?url=<URL_DO_STREAM>

Exemplo:
${url.origin}/?url=https://servidor.com/stream.m3u8

Headers CORS sao adicionados automaticamente.
Manifests M3U8 tem suas URLs internas reescritas.
`,
        {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders(request),
          },
        }
      );
    }

    // Valida URL alvo
    let targetUrl;
    try {
      targetUrl = new URL(target);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        throw new Error('Protocolo invalido');
      }
    } catch (e) {
      return new Response('URL invalida: ' + e.message, {
        status: 400,
        headers: { 'Content-Type': 'text/plain', ...corsHeaders(request) },
      });
    }

    // Faz request ao servidor original
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (compatible; HLS-Proxy/1.0)',
    };
    if (referer) upstreamHeaders['Referer'] = referer;

    // Repassa Range header (importante para streaming)
    const range = request.headers.get('Range');
    if (range) upstreamHeaders['Range'] = range;

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers: upstreamHeaders,
        // Cloudflare Workers honra estas opcoes
        cf: { cacheTtl: 5, cacheEverything: false },
      });
    } catch (e) {
      return new Response('Erro upstream: ' + e.message, {
        status: 502,
        headers: { 'Content-Type': 'text/plain', ...corsHeaders(request) },
      });
    }

    const contentType = upstream.headers.get('Content-Type') || '';

    // Se for manifest, le, reescreve URLs e devolve
    if (isManifest(targetUrl.toString(), contentType)) {
      const text = await upstream.text();

      if (text.length > MAX_MANIFEST_SIZE) {
        return new Response('Manifest muito grande', {
          status: 413,
          headers: corsHeaders(request),
        });
      }

      const proxyBase = url.origin;
      const rewritten = rewriteManifest(text, targetUrl.toString(), proxyBase, referer);

      return new Response(rewritten, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
          ...corsHeaders(request),
        },
      });
    }

    // Caso contrario (segmento .ts/.m4s/.aac/.key), repassa stream direto
    const respHeaders = new Headers(corsHeaders(request));
    // Preserva headers relevantes do upstream
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control']) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
