// worker.js — Roblox Avatar Proxy (Cloudflare Worker)
// Sem dependências externas. Cache em memória (não usa KV nem D1).

const SUBDOMINIOS_PERMITIDOS = ["avatar", "thumbnails"];
const CACHE_SEGUNDOS = 300;      // 5 minutos
const CACHE_MAX_ENTRADAS = 500;  // limpeza ao ultrapassar

const cache = new Map();

function limparCache() {
	const agora = Date.now();
	for (const [chave, item] of cache) {
		if (agora - item.em > CACHE_SEGUNDOS * 1000) {
			cache.delete(chave);
		}
	}
	while (cache.size > CACHE_MAX_ENTRADAS) {
		cache.delete(cache.keys().next().value);
	}
}

function respostaCors(corpo, status, headersExtra) {
	const headers = new Headers(headersExtra);
	headers.set("Access-Control-Allow-Origin", "*");
	return new Response(corpo, { status, headers });
}

export default {
	async fetch(request) {
		const url = new URL(request.url);

		// Preflight CORS (para testar no navegador)
		if (request.method === "OPTIONS") {
			return respostaCors(null, 204, {
				"Access-Control-Allow-Methods": "GET, HEAD",
				"Access-Control-Allow-Headers": "Accept"
			});
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return respostaCors("Metodo nao permitido", 405);
		}

		const partes = url.pathname.split("/");
		const sub = (partes[1] || "").toLowerCase();

		if (!SUBDOMINIOS_PERMITIDOS.includes(sub)) {
			return respostaCors("Subdominio nao permitido", 403);
		}

		const caminho = "/" + partes.slice(2).join("/");
		const destino = new URL(caminho + url.search, `https://${sub}.roblox.com`);
		const chaveCache = destino.toString();

		// CACHE HIT — devolve sem consultar o Roblox
		const agora = Date.now();
		const item = cache.get(chaveCache);
		if (item && agora - item.em < CACHE_SEGUNDOS * 1000) {
			return respostaCors(request.method === "HEAD" ? null : item.corpo, item.status, {
				"Content-Type": item.contentType,
				"X-Cache": "HIT"
			});
		}

		// Headers limpos: não encaminha os headers do HttpService
		const headers = new Headers();
		headers.set("Accept", "application/json");
		headers.set(
			"User-Agent",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
		);

		try {
			const resposta = await fetch(destino.toString(), {
				method: request.method,
				headers,
				redirect: "follow"
			});

			// Erros (429, 403...) passam direto, sem cachear
			if (!resposta.ok) {
				const corpoErro = await resposta.text();
			return respostaCors(corpoErro, resposta.status, {
				"Content-Type": "application/json",
				"X-Cache": "MISS"
			});
			}

			const corpo = await resposta.text();
		const contentType = resposta.headers.get("Content-Type") || "application/json";

			cache.set(chaveCache, {
				em: agora,
				status: resposta.status,
				corpo,
				contentType
			});
			limparCache();

			return respostaCors(request.method === "HEAD" ? null : corpo, resposta.status, {
				"Content-Type": contentType,
				"X-Cache": "MISS"
			});
		} catch (error) {
			return respostaCors(
				JSON.stringify({
					error: "Falha ao consultar a Roblox",
					message: String(error),
				destination: destino.toString()
			}),
			502,
			{ "Content-Type": "application/json" }
			);
		}
	}
};
