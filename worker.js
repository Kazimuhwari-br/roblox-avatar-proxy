// worker.js — Roblox Avatar Proxy (Cloudflare Worker)
// Sem dependências externas. Cache em memória.
//
// Uso: https://SUA-WORKER.workers.dev/avatar/v1/users/{userId}/outfits
//
// Mudanças desta versão:
//  - Tenta roblox.com primeiro e, se for bloqueado/limitado (403/429/5xx),
//    tenta roproxy.com automaticamente.
//  - Quando falha, devolve o erro REAL (status + corpo do upstream) em JSON,
//    para você conseguir ver o que está acontecendo.
//  - Headers X-Upstream / X-Upstream-Status em toda resposta (debug).

const SUBDOMINIOS_PERMITIDOS = ["avatar", "thumbnails"];
const DOMINIOS_UPSTREAM = ["roblox.com", "roproxy.com"];
const CACHE_SEGUNDOS = 300;
const CACHE_MAX_ENTRADAS = 500;

const cache = new Map();

function limparCache() {
	const agora = Date.now();
	for (const [chave, item] of cache) {
		if (agora - item.em > CACHE_SEGUNDOS * 1000) cache.delete(chave);
	}
	while (cache.size > CACHE_MAX_ENTRADAS) {
		cache.delete(cache.keys().next().value);
	}
}

function resposta(corpo, status, extra) {
	const headers = new Headers(extra);
	headers.set("Access-Control-Allow-Origin", "*");
	return new Response(corpo, { status, headers });
}

// Status em que vale a pena tentar outro upstream
function deveTentarOutro(status) {
	return status === 403 || status === 429 || status >= 500;
}

export default {
	async fetch(request) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return resposta(null, 204, {
				"Access-Control-Allow-Methods": "GET, HEAD",
				"Access-Control-Allow-Headers": "Accept"
			});
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return resposta("Metodo nao permitido", 405);
		}

		const partes = url.pathname.split("/");
		const sub = (partes[1] || "").toLowerCase();

		if (!SUBDOMINIOS_PERMITIDOS.includes(sub)) {
			return resposta(
				JSON.stringify({ error: "Subdominio nao permitido", permitidos: SUBDOMINIOS_PERMITIDOS }),
				403,
				{ "Content-Type": "application/json" }
			);
		}

		const caminho = "/" + partes.slice(2).join("/");
		const chaveCache = sub + caminho + url.search;

		// CACHE HIT
		const agora = Date.now();
		const item = cache.get(chaveCache);
		if (item && agora - item.em < CACHE_SEGUNDOS * 1000) {
			return resposta(request.method === "HEAD" ? null : item.corpo, item.status, {
				"Content-Type": item.contentType,
				"X-Cache": "HIT",
				"X-Upstream": item.upstream
			});
		}

		const tentativas = [];
		let ultimo = null;

		for (const dominio of DOMINIOS_UPSTREAM) {
			const destino = `https://${sub}.${dominio}${caminho}${url.search}`;

			try {
				const upstream = await fetch(destino, {
					method: "GET",
					headers: {
						"Accept": "application/json",
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
					},
					redirect: "follow"
				});

				const corpo = await upstream.text();
				const contentType = upstream.headers.get("Content-Type") || "application/json";

				if (upstream.ok) {
					cache.set(chaveCache, {
						em: agora,
						status: upstream.status,
						corpo,
						contentType,
						upstream: dominio
					});
					limparCache();

					return resposta(request.method === "HEAD" ? null : corpo, upstream.status, {
						"Content-Type": contentType,
						"X-Cache": "MISS",
						"X-Upstream": dominio
					});
				}

				tentativas.push({ dominio, status: upstream.status, corpo: corpo.slice(0, 500) });
				ultimo = { status: upstream.status, corpo, contentType, dominio };

				// Erro "de verdade" (400, 404...) -> não adianta tentar outro
				if (!deveTentarOutro(upstream.status)) break;
			} catch (error) {
				tentativas.push({ dominio, status: 0, corpo: String(error) });
			}
		}

		// Falhou em todos: devolve o erro real para facilitar o debug
		const statusFinal = ultimo ? ultimo.status : 502;
		return resposta(
			JSON.stringify({
				error: "Falha ao consultar a Roblox",
				caminho: `/${sub}${caminho}${url.search}`,
				tentativas
			}),
			statusFinal,
			{
				"Content-Type": "application/json",
				"X-Cache": "MISS",
				"X-Upstream-Status": String(statusFinal)
			}
		);
	}
};
