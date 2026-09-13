package com.torrange.app

import android.content.Context
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

/** Recusa da API, ja traduzida para algo que o aplicativo possa decidir em cima. */
class ErroApi(
    val erro: String,
    mensagem: String,
    val status: Int = 0,
    val retryAfter: Int = 0,
    val dados: JSONObject? = null
) : Exception(mensagem.ifEmpty { erro.ifEmpty { "HTTP $status" } })

/** Falha de rede: o servidor nao respondeu. Nao e recusa, e ausencia. */
class ErroRede(mensagem: String) : Exception(mensagem) {
    val erro = "sem_rede"
}

/**
 * Cliente da API do aplicativo (https://torrange.com/api/aplicativo).
 *
 * E a mesma especificacao do desktop, e as regras que moldam o arquivo sao as
 * mesmas:
 *
 *  - Dois cabecalhos vao em TODA chamada: X-Aplicativo-Token (o token de 100
 *    caracteres) e X-Aplicativo-Instalacao (o id fixo deste aparelho).
 *  - Toda recusa tem a mesma forma {"erro": ..., "mensagem": ...} e quem decide
 *    e o campo `erro`, nunca a frase -- a mensagem pode mudar a qualquer
 *    momento, o codigo nao.
 *  - O POST /baixar/{item} COBRA. Ele nunca e repetido sozinho: um retry cego
 *    depois de um timeout debita duas vezes. Por isso `retryOnConnectionFailure`
 *    fica desligado no cliente.
 *  - O token e uma senha: nao entra em URL, em log nem em mensagem de erro.
 */
class Api(private val contexto: Context) {

    class Resposta(
        val status: Int,
        val tipo: String,
        val nome: String,
        val retryAfter: Int,
        val bytes: ByteArray,
        val json: JSONObject?
    )

    private var enderecoBase = "https://torrange.com/api/aplicativo"

    private val cliente = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        // Sem repetir nada sozinho: ha um verbo aqui que cobra gema.
        .retryOnConnectionFailure(false)
        .build()

    fun configurar(url: String?) {
        if (!url.isNullOrBlank()) enderecoBase = url.trimEnd('/')
    }

    fun base(): String = enderecoBase

    private fun montarUrl(rota: String, parametros: Map<String, Any?>?): HttpUrl {
        val caminho = if (rota.startsWith("/")) rota else "/$rota"
        val url = (enderecoBase + caminho).toHttpUrlOrNull()
            ?: throw ErroRede("endereço da API inválido")
        val construtor = url.newBuilder()
        parametros?.forEach { (chave, valor) ->
            val texto = valor?.toString() ?: return@forEach
            if (texto.isEmpty()) return@forEach
            construtor.setQueryParameter(chave, texto)
        }
        return construtor.build()
    }

    /** Le o nome do arquivo do Content-Disposition (aceita filename*=UTF-8''...). */
    private fun nomeDoCabecalho(disposicao: String?): String {
        if (disposicao.isNullOrEmpty()) return ""
        Regex("filename\\*\\s*=\\s*[^']*'[^']*'([^;]+)", RegexOption.IGNORE_CASE)
            .find(disposicao)?.let {
                val bruto = it.groupValues[1].trim()
                return try {
                    URLDecoder.decode(bruto, "UTF-8")
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

    /**
     * Uma chamada crua. Nao decide nada sobre erro -- quem decide e `chamar`.
     * Roda na linha que chamou: todo uso passa por um contexto de IO.
     */
    private fun requisicao(
        metodo: String,
        url: HttpUrl,
        corpo: JSONObject? = null,
        aceitar: String = "application/json"
    ): Resposta {
        val token = Credenciais.lerToken(contexto)
        if (token.isEmpty()) {
            throw ErroApi("token_ausente", "Nenhum token cadastrado neste aplicativo.", 401)
        }

        val pedido = Request.Builder()
            .url(url)
            .header("X-Aplicativo-Token", token)
            .header("X-Aplicativo-Instalacao", Credenciais.idInstalacao(contexto))
            .header("Accept", aceitar)
            .apply {
                if (corpo != null) {
                    method(metodo, corpo.toString().toRequestBody("application/json".toMediaType()))
                } else if (metodo == "POST") {
                    method(metodo, "".toRequestBody("application/json".toMediaType()))
                } else {
                    method(metodo, null)
                }
            }
            .build()

        try {
            cliente.newCall(pedido).execute().use { resposta ->
                val bytes = resposta.body?.bytes() ?: ByteArray(0)
                val tipo = (resposta.header("content-type") ?: "").substringBefore(';').trim()
                val json = if (tipo.contains("json", true) && bytes.isNotEmpty()) {
                    try {
                        JSONObject(String(bytes, Charsets.UTF_8))
                    } catch (e: Exception) {
                        null
                    }
                } else null

                return Resposta(
                    status = resposta.code,
                    tipo = tipo,
                    nome = nomeDoCabecalho(resposta.header("content-disposition")),
                    retryAfter = resposta.header("retry-after")?.toIntOrNull() ?: 0,
                    bytes = bytes,
                    json = json
                )
            }
        } catch (e: IOException) {
            throw ErroRede(e.message ?: "o servidor não respondeu a tempo")
        }
    }

    /**
     * Chamada com o tratamento de recusa da especificacao.
     *
     * `aceitandoStatus` lista status que NAO sao erro para quem chamou -- e como
     * o 402 confirmacao_necessaria chega inteiro na tela de confirmacao de gemas.
     */
    fun chamar(
        metodo: String,
        rota: String,
        parametros: Map<String, Any?>? = null,
        corpo: JSONObject? = null,
        aceitar: String = "application/json",
        aceitandoStatus: List<Int> = emptyList()
    ): Resposta {
        val r = requisicao(metodo, montarUrl(rota, parametros), corpo, aceitar)

        if (r.status in 200..299) return r
        if (aceitandoStatus.contains(r.status)) return r

        val dados = r.json ?: JSONObject()
        // 422 e o unico formato diferente: {"message": ..., "errors": {...}}
        val mensagem = dados.optString("mensagem").ifEmpty {
            dados.optString("message").ifEmpty { "O servidor respondeu HTTP ${r.status}." }
        }
        throw ErroApi(
            erro = dados.optString("erro").ifEmpty {
                if (r.status == 429) "muitas_chamadas" else "http_${r.status}"
            },
            mensagem = mensagem,
            status = r.status,
            retryAfter = r.retryAfter,
            dados = dados
        )
    }

    private fun json(
        metodo: String,
        rota: String,
        parametros: Map<String, Any?>? = null,
        corpo: JSONObject? = null
    ): JSONObject = chamar(metodo, rota, parametros, corpo).json ?: JSONObject()

    // ----------------------------------------------------------- endpoints

    /**
     * Apresenta este aparelho. E a unica rota que um aplicativo ainda nao
     * autorizado alcanca, e chamar de novo e seguro: a mesma instalacao
     * reencontra a propria vaga, nao gasta outra e nao perde a permissao.
     */
    fun conexao(nome: String, plataforma: String): JSONObject =
        json("POST", "/conexao", corpo = JSONObject().put("nome", nome).put("plataforma", plataforma))

    /** Chamada de abertura -- e tambem o jeito barato de saber que a autorizacao saiu. */
    fun conta(): JSONObject = json("GET", "/conta")

    fun acervo(filtros: Map<String, Any?>): JSONObject = json("GET", "/acervo", filtros)

    fun titulo(chave: String): JSONObject = json("GET", "/titulo/${enc(chave)}")

    /** Bytes da capa (webp). null quando o item nao tem imagem. */
    fun capa(item: String): Pair<ByteArray, String>? {
        val r = chamar(
            "GET", "/capa/${enc(item)}",
            aceitar = "image/webp,image/*",
            aceitandoStatus = listOf(404)
        )
        if (r.status == 404 || r.bytes.isEmpty()) return null
        return Pair(r.bytes, r.tipo.ifEmpty { "image/webp" })
    }

    class Torrent(val dados: ByteArray, val nome: String)
    class Confirmacao(val item: String, val preco: Double, val saldo: Double, val mensagem: String)
    class Entrega(val torrent: Torrent?, val confirmacao: Confirmacao?)

    /**
     * Baixar o que e free. Este verbo NUNCA debita gema -- repetir depois de um
     * timeout e seguro.
     */
    fun baixar(item: String): Entrega {
        val r = chamar(
            "GET", "/baixar/${enc(item)}",
            aceitar = "application/x-bittorrent,application/json",
            aceitandoStatus = listOf(402)
        )

        if (r.status == 402) {
            val d = r.json ?: JSONObject()
            val codigo = d.optString("erro")
            if (codigo.isNotEmpty() && codigo != "confirmacao_necessaria") {
                throw ErroApi(codigo, d.optString("mensagem"), 402, dados = d)
            }
            return Entrega(
                null,
                Confirmacao(
                    item = item,
                    preco = d.optDouble("preco", 0.0),
                    saldo = d.optDouble("saldo", 0.0),
                    mensagem = d.optString("mensagem")
                )
            )
        }
        return Entrega(comoTorrent(r, item), null)
    }

    /**
     * O unico caminho que debita. Vai o preco que o usuario viu e aceitou; o
     * servidor reconfere contra o vigente antes de tocar no saldo.
     *
     * Nao ha retry aqui, de proposito: cada chamada entrega e cobra por si.
     */
    fun confirmarBaixar(item: String, preco: Double): Entrega {
        val r = chamar(
            "POST", "/baixar/${enc(item)}",
            corpo = JSONObject().put("preco", preco),
            aceitar = "application/x-bittorrent,application/json"
        )
        return Entrega(comoTorrent(r, item), null)
    }

    private fun comoTorrent(r: Resposta, item: String): Torrent {
        if (r.bytes.size < 16) {
            throw ErroApi("resposta_vazia", "O servidor respondeu sem o arquivo .torrent.", r.status)
        }
        val nome = if (r.nome.endsWith(".torrent", true)) r.nome
        else "${r.nome.ifEmpty { "torrange-$item" }}.torrent"
        return Torrent(r.bytes, nome)
    }

    fun favoritos(pagina: Int = 1): JSONObject = json("GET", "/favoritos", mapOf("page" to pagina))

    /** Liga e desliga a estrela -- e alternancia, nao "adicionar". */
    fun alternarFavorito(chave: String, item: String?): JSONObject =
        json("POST", "/favoritos", corpo = JSONObject().put("chave", chave).apply {
            if (!item.isNullOrEmpty()) put("item", item)
        })

    fun baixados(pagina: Int = 1): JSONObject = json("GET", "/baixados", mapOf("page" to pagina))

    private fun enc(valor: String): String =
        java.net.URLEncoder.encode(valor, "UTF-8").replace("+", "%20")
}
