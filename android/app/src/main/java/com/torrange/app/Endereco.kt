package com.torrange.app

import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Entrada de torrents por endereco web, usada pela caixa da aba Downloads.
 *
 * O que foi preservado do desktop, porque cada item aqui ja foi um bug:
 *  - seguimos os redirecionamentos mantendo o Referer (caso da CDN);
 *  - se vier HTML, procuramos o link do .torrent dentro da pagina;
 *  - o conteudo e conferido como bencode de verdade antes de virar torrent,
 *    para uma pagina de erro com HTTP 200 nao entrar na fila como se fosse
 *    arquivo.
 */
object Endereco {

    private const val MAX_REDIRECIONAMENTOS = 5

    class Arquivo(val dados: ByteArray, val nome: String)

    private class Resposta(
        val status: Int,
        val tipo: String,
        val nome: String,
        val dados: ByteArray,
        val url: String
    )

    // O OkHttp segue redirecionamento sozinho e ja repassa o Referer quando o
    // definimos; o cliente fica com ele ligado e um teto de saltos proprio.
    private val cliente = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .callTimeout(60, TimeUnit.SECONDS)
        .build()

    fun ehTorrent(url: String = "", nome: String = "", mime: String = ""): Boolean =
        mime == "application/x-bittorrent" ||
            Regex("\\.torrent(\\?|#|$)", RegexOption.IGNORE_CASE).containsMatchIn(url) ||
            nome.endsWith(".torrent", true) ||
            Regex("/(baixar|download)/\\d+", RegexOption.IGNORE_CASE).containsMatchIn(url)

    /** Um .torrent e um dicionario bencode: sempre comeca com "d" e tem a chave "info". */
    fun ehBytesTorrent(dados: ByteArray?): Boolean {
        if (dados == null || dados.size <= 16) return false
        if (dados[0] != 'd'.code.toByte()) return false
        val alvo = "4:info".toByteArray()
        outer@ for (i in 0..(dados.size - alvo.size)) {
            for (j in alvo.indices) if (dados[i + j] != alvo[j]) continue@outer
            return true
        }
        return false
    }

    private fun nomeDoCabecalho(disposicao: String?): String {
        if (disposicao.isNullOrEmpty()) return ""
        Regex("filename\\*\\s*=\\s*[^']*'[^']*'([^;]+)", RegexOption.IGNORE_CASE)
            .find(disposicao)?.let {
                val bruto = it.groupValues[1].trim()
                return try {
                    java.net.URLDecoder.decode(bruto, "UTF-8")
                } catch (e: Exception) {
                    bruto
                }
            }
        Regex("filename\\s*=\\s*\"([^\"]+)\"|filename\\s*=\\s*([^;]+)", RegexOption.IGNORE_CASE)
            .find(disposicao)?.let {
                return (it.groupValues[1].ifEmpty { it.groupValues[2] }).trim()
            }
        return ""
    }

    private fun nomeDaUrl(url: String): String = try {
        val base = android.net.Uri.parse(url).lastPathSegment ?: ""
        if (base.endsWith(".torrent", true)) base else ""
    } catch (e: Exception) {
        ""
    }

    private fun buscar(url: String, referer: String = ""): Resposta {
        val pedido = Request.Builder()
            .url(url)
            .header("Accept", "application/x-bittorrent,application/octet-stream,*/*")
            .apply { if (referer.isNotEmpty()) header("Referer", referer) }
            .build()

        cliente.newCall(pedido).execute().use { r ->
            val bytes = r.body?.bytes() ?: ByteArray(0)
            return Resposta(
                status = r.code,
                tipo = (r.header("content-type") ?: "").substringBefore(';').trim(),
                nome = nomeDoCabecalho(r.header("content-disposition")).ifEmpty { nomeDaUrl(url) },
                dados = bytes,
                url = r.request.url.toString()
            )
        }
    }

    /** Procura o link de download dentro de uma pagina. */
    private fun linkNaPagina(html: String, base: String): String? {
        for (achado in Regex("href\\s*=\\s*[\"']([^\"']+)[\"']", RegexOption.IGNORE_CASE).findAll(html)) {
            val endereco = achado.groupValues[1].replace("&amp;", "&")
            if (!ehTorrent(url = endereco)) continue
            try {
                return java.net.URL(java.net.URL(base), endereco).toString()
            } catch (e: Exception) {
                // href estranho: tenta o proximo
            }
        }
        return null
    }

    /**
     * Busca o .torrent de um endereco. Devolve null quando o endereco nao e um
     * torrent. Com seguirPagina, se vier HTML procuramos o link de baixar
     * dentro dele -- assim colar o endereco da pagina do item tambem funciona.
     */
    fun pegar(url: String, referer: String = "", seguirPagina: Boolean = false, saltos: Int = 0): Arquivo? {
        if (saltos > MAX_REDIRECIONAMENTOS) throw Exception("o endereço redirecionou vezes demais")

        val r = buscar(url, referer)
        if (r.status >= 400) throw Exception("o servidor respondeu HTTP ${r.status}")

        if (r.tipo == "application/x-bittorrent" || ehBytesTorrent(r.dados)) {
            val nome = if (r.nome.endsWith(".torrent", true)) r.nome
            else "${r.nome.ifEmpty { "torrange" }}.torrent"
            return Arquivo(r.dados, nome)
        }

        if (seguirPagina && r.tipo.contains("html", true)) {
            val link = linkNaPagina(String(r.dados, Charsets.UTF_8), r.url)
            if (link != null && link != url) {
                return pegar(link, referer = r.url, seguirPagina = false, saltos = saltos + 1)
            }
        }

        return null
    }
}
