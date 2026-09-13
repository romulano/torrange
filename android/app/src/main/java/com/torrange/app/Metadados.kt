package com.torrange.app

import android.content.Context
import android.net.Uri
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/**
 * Organizacao da biblioteca: pastas, capas, nomes de exibicao, descricoes e
 * etiquetas.
 *
 * Fica num arquivo proprio (organizacao.json), separado do catalogo. O catalogo
 * e reconstruido a cada ciclo a partir do motor de torrent; o que voce edita
 * aqui nao pode ser atropelado por isso.
 *
 * As pastas sao VIRTUAIS: existem so dentro do aplicativo. Renomear, mover ou
 * apagar uma pasta nunca toca num arquivo em disco nem no torrent que o
 * alimenta -- entao nada quebra o seeding.
 */
class Metadados(private val contexto: Context) {

    companion object {
        private val EXT_IMAGEM = setOf("jpg", "jpeg", "png", "webp", "gif", "avif", "bmp")
        private const val TAMANHO_MAXIMO_CAPA = 12 * 1024 * 1024 // 12 MB

        private val MIMES = mapOf(
            "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png",
            "webp" to "image/webp", "gif" to "image/gif", "avif" to "image/avif",
            "bmp" to "image/bmp"
        )
    }

    private var dados: JSONObject? = null
    private var pendente = false

    private val cliente = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    // ------------------------------------------------------------ persistencia

    @Synchronized
    private fun carregar(): JSONObject {
        dados?.let { return it }
        val lido = try {
            JSONObject(Caminhos.organizacao(contexto).readText())
        } catch (e: Exception) {
            JSONObject()
        }
        if (!lido.has("pastas")) lido.put("pastas", JSONObject())
        if (!lido.has("titulos")) lido.put("titulos", JSONObject())
        dados = lido
        return lido
    }

    private fun pastas(): JSONObject = carregar().getJSONObject("pastas")
    private fun titulos(): JSONObject = carregar().getJSONObject("titulos")

    @Synchronized
    private fun gravar() {
        if (pendente) return
        pendente = true
        Thread {
            Thread.sleep(300)
            synchronized(this) {
                pendente = false
                try {
                    Caminhos.organizacao(contexto).writeText(carregar().toString(2))
                } catch (e: Exception) {
                    Diagnostico.anotar("erro", "falha ao gravar a organizacao: ${e.message}")
                }
            }
        }.start()
    }

    private fun novoId(): String {
        val bytes = ByteArray(8)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun texto(valor: Any?, limite: Int = 4000): String =
        (valor as? String)?.trim()?.take(limite) ?: ""

    // ------------------------------------------------------------------ pastas

    /** Impede que uma pasta vire descendente de si mesma ao ser movida. */
    private fun ehDescendente(possivelFilho: String, possivelPai: String): Boolean {
        var atual = pastas().optJSONObject(possivelFilho)
        val vistos = HashSet<String>()
        while (atual != null) {
            val pai = atual.optString("pai").ifEmpty { null } ?: return false
            if (pai == possivelPai) return true
            if (!vistos.add(pai)) return false
            atual = pastas().optJSONObject(pai)
        }
        return false
    }

    @Synchronized
    fun criarPasta(dadosEntrada: JSONObject): JSONObject {
        val id = novoId()
        val pai = dadosEntrada.optString("pai").ifEmpty { null }
        val pasta = JSONObject()
            .put("id", id)
            .put("nome", texto(dadosEntrada.opt("nome"), 120).ifEmpty { "Nova pasta" })
            .put("descricao", "")
            .put("capa", JSONObject.NULL)
            .put("pai", if (pai != null && pastas().has(pai)) pai else JSONObject.NULL)
            .put("criadaEm", System.currentTimeMillis())
        pastas().put(id, pasta)
        gravar()
        return pasta
    }

    @Synchronized
    fun editarPasta(id: String, campos: JSONObject): JSONObject? {
        val pasta = pastas().optJSONObject(id) ?: return null

        if (campos.has("nome")) {
            val novo = texto(campos.opt("nome"), 120)
            if (novo.isNotEmpty()) pasta.put("nome", novo)
        }
        if (campos.has("descricao")) pasta.put("descricao", texto(campos.opt("descricao")))
        if (campos.has("pai")) {
            val alvo = campos.optString("pai").ifEmpty { null }
            val valido = alvo == null ||
                (pastas().has(alvo) && alvo != id && !ehDescendente(alvo, id))
            if (valido) pasta.put("pai", alvo ?: JSONObject.NULL)
        }
        gravar()
        return pasta
    }

    /** Remove a pasta. O que estava dentro sobe um nivel -- nada se perde. */
    @Synchronized
    fun removerPasta(id: String): Boolean {
        val pasta = pastas().optJSONObject(id) ?: return false
        val destino: Any = pasta.opt("pai") ?: JSONObject.NULL

        for (chave in pastas().keys()) {
            val outra = pastas().optJSONObject(chave) ?: continue
            if (outra.optString("pai") == id) outra.put("pai", destino)
        }
        for (chave in titulos().keys()) {
            val titulo = titulos().optJSONObject(chave) ?: continue
            if (titulo.optString("pasta") == id) titulo.put("pasta", destino)
        }
        apagarArquivoCapa(pasta.optString("capa"))
        pastas().remove(id)
        gravar()
        return true
    }

    @Synchronized
    fun listarPastas(): List<JSONObject> =
        pastas().keys().asSequence()
            .mapNotNull { pastas().optJSONObject(it) }
            .sortedBy { it.optString("nome").lowercase() }
            .toList()

    /** Caminho da raiz ate a pasta, para a trilha de navegacao. */
    @Synchronized
    fun trilha(id: String?): JSONArray {
        val caminho = mutableListOf<JSONObject>()
        val vistos = HashSet<String>()
        var atual = if (id.isNullOrEmpty()) null else pastas().optJSONObject(id)
        while (atual != null && vistos.add(atual.optString("id"))) {
            caminho.add(0, JSONObject().put("id", atual.optString("id")).put("nome", atual.optString("nome")))
            val pai = atual.optString("pai").ifEmpty { null }
            atual = if (pai != null) pastas().optJSONObject(pai) else null
        }
        return JSONArray().apply { caminho.forEach { put(it) } }
    }

    // ----------------------------------------------------------------- titulos

    @Synchronized
    private fun doTitulo(hash: String): JSONObject {
        titulos().optJSONObject(hash)?.let { return it }
        val novo = JSONObject()
            .put("nome", "")
            .put("descricao", "")
            .put("capa", JSONObject.NULL)
            .put("etiquetas", JSONArray())
            .put("pasta", JSONObject.NULL)
            .put("arquivos", JSONObject())
        titulos().put(hash, novo)
        return novo
    }

    @Synchronized
    fun editarTitulo(hash: String, campos: JSONObject): JSONObject {
        val t = doTitulo(hash)
        if (campos.has("nome")) t.put("nome", texto(campos.opt("nome"), 200))
        if (campos.has("descricao")) t.put("descricao", texto(campos.opt("descricao")))
        if (campos.has("etiquetas")) {
            val cru = campos.opt("etiquetas")
            val lista = when (cru) {
                is JSONArray -> (0 until cru.length()).map { cru.optString(it) }
                else -> cru.toString().split(",")
            }
            val limpas = lista.map { texto(it, 40) }.filter { it.isNotEmpty() }.distinct().take(20)
            t.put("etiquetas", JSONArray().apply { limpas.forEach { put(it) } })
        }
        if (campos.has("pasta")) {
            val pasta = campos.optString("pasta").ifEmpty { null }
            t.put("pasta", if (pasta != null && pastas().has(pasta)) pasta else JSONObject.NULL)
        }
        gravar()
        return t
    }

    /** Nome de exibicao de um arquivo (episodio) dentro de um titulo. */
    @Synchronized
    fun editarArquivo(hash: String, caminho: String, nome: String?): JSONObject {
        val t = doTitulo(hash)
        val arquivos = t.optJSONObject("arquivos") ?: JSONObject().also { t.put("arquivos", it) }
        val limpo = texto(nome, 200)
        if (limpo.isNotEmpty()) arquivos.put(caminho, JSONObject().put("nome", limpo))
        else arquivos.remove(caminho)
        gravar()
        return t
    }

    // ------------------------------------------------------------------- capas

    private fun apagarArquivoCapa(nome: String?) {
        if (nome.isNullOrEmpty() || nome == "null") return
        try {
            File(Caminhos.capas(contexto), File(nome).name).delete()
        } catch (e: Exception) {
            // ja nao existe
        }
    }

    private fun extensaoValida(origem: String): String? {
        val caminho = try {
            Uri.parse(origem).path ?: origem
        } catch (e: Exception) {
            origem
        }
        val ext = caminho.substringAfterLast('.', "").lowercase()
        return if (EXT_IMAGEM.contains(ext)) ext else null
    }

    private fun baixarImagem(url: String): Pair<ByteArray, String> {
        cliente.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw Exception("o servidor respondeu ${r.code}")
            val tipo = (r.header("content-type") ?: "").substringBefore(';').trim()
            if (!tipo.startsWith("image/")) {
                throw Exception("o link nao aponta para uma imagem (${tipo.ifEmpty { "sem tipo" }})")
            }
            val bytes = r.body?.bytes() ?: ByteArray(0)
            if (bytes.size > TAMANHO_MAXIMO_CAPA) throw Exception("a imagem passa de 12 MB")
            val ext = extensaoValida(url)
                ?: MIMES.entries.firstOrNull { it.value == tipo }?.key
                ?: "jpg"
            return Pair(bytes, ext)
        }
    }

    /**
     * Le a imagem que o usuario escolheu. No Android o seletor entrega um
     * content:// (nao um caminho), entao a leitura passa pelo ContentResolver.
     */
    private fun lerImagemLocal(origem: String): Pair<ByteArray, String> {
        val uri = Uri.parse(origem)
        val bytes = if (uri.scheme == "content") {
            contexto.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw Exception("nao consegui ler a imagem escolhida")
        } else {
            File(uri.path ?: origem).readBytes()
        }
        if (bytes.size > TAMANHO_MAXIMO_CAPA) throw Exception("a imagem passa de 12 MB")

        val tipo = if (uri.scheme == "content") contexto.contentResolver.getType(uri) ?: "" else ""
        val ext = extensaoValida(origem)
            ?: MIMES.entries.firstOrNull { it.value == tipo.substringBefore(';').trim() }?.key
            ?: "jpg"
        return Pair(bytes, ext)
    }

    /**
     * Guarda a capa dentro dos dados do aplicativo -- uma COPIA, para a
     * biblioteca nao quebrar se o arquivo original for movido ou apagado.
     */
    @Synchronized
    fun definirCapa(alvo: JSONObject, origem: JSONObject): String {
        val tipo = alvo.optString("tipo")
        val id = alvo.optString("id")
        val destino = (if (tipo == "pasta") pastas().optJSONObject(id) else doTitulo(id))
            ?: throw Exception("item não encontrado")

        val url = origem.optString("url")
        val (bytes, ext) = if (url.isNotEmpty()) baixarImagem(url)
        else lerImagemLocal(origem.optString("arquivo"))

        val nome = "${novoId()}.$ext"
        File(Caminhos.capas(contexto), nome).writeBytes(bytes)

        apagarArquivoCapa(destino.optString("capa"))
        destino.put("capa", nome)
        gravar()
        return nome
    }

    @Synchronized
    fun removerCapa(alvo: JSONObject): Boolean {
        val tipo = alvo.optString("tipo")
        val id = alvo.optString("id")
        val destino = if (tipo == "pasta") pastas().optJSONObject(id) else titulos().optJSONObject(id)
        if (destino == null) return false
        apagarArquivoCapa(destino.optString("capa"))
        destino.put("capa", JSONObject.NULL)
        gravar()
        return true
    }

    /** Serve o arquivo da capa para o endereco capa/img/<nome>. */
    fun lerCapa(nome: String?): Pair<ByteArray, String>? {
        val seguro = File(nome ?: "").name
        if (seguro.isEmpty()) return null
        val arquivo = File(Caminhos.capas(contexto), seguro)
        if (!arquivo.exists()) return null
        val mime = MIMES[seguro.substringAfterLast('.', "").lowercase()] ?: "image/jpeg"
        return Pair(arquivo.readBytes(), mime)
    }

    /**
     * O endereco que a interface poe no src da imagem.
     *
     * No desktop era o esquema proprio `capa://img/<nome>`. Aqui a pagina toda
     * e servida de uma origem so (o WebViewAssetLoader), e um caminho relativo
     * dentro dela faz o mesmo papel -- sem precisar registrar esquema nenhum
     * nem afrouxar a CSP.
     */
    fun urlDaCapa(nome: String?): Any {
        if (nome.isNullOrEmpty() || nome == "null") return JSONObject.NULL
        return "capa/img/" + Uri.encode(nome)
    }

    // -------------------------------------------------------------------- juncao

    /** Junta o catalogo da biblioteca com o que o usuario editou. */
    @Synchronized
    fun aplicar(entradas: JSONArray): JSONArray {
        val saida = JSONArray()
        for (i in 0 until entradas.length()) {
            val e = JSONObject(entradas.optJSONObject(i).toString())
            val hash = e.optString("hash")
            val meta = titulos().optJSONObject(hash)

            e.put("nomeOriginal", e.optString("nome"))

            if (meta == null) {
                e.put("etiquetas", JSONArray())
                e.put("pasta", JSONObject.NULL)
                e.put("capa", JSONObject.NULL)
                saida.put(e)
                continue
            }

            val nome = meta.optString("nome")
            if (nome.isNotEmpty()) e.put("nome", nome)
            e.put("descricao", meta.optString("descricao"))
            e.put("etiquetas", meta.optJSONArray("etiquetas") ?: JSONArray())
            e.put("pasta", meta.opt("pasta") ?: JSONObject.NULL)
            e.put("capa", urlDaCapa(meta.optString("capa")))

            val nomesDeArquivo = meta.optJSONObject("arquivos") ?: JSONObject()
            val arquivos = e.optJSONArray("arquivos") ?: JSONArray()
            val novos = JSONArray()
            for (j in 0 until arquivos.length()) {
                val a = JSONObject(arquivos.optJSONObject(j).toString())
                val original = a.optString("nome")
                a.put("nomeOriginal", original)
                val escolhido = nomesDeArquivo.optJSONObject(a.optString("caminho"))?.optString("nome")
                if (!escolhido.isNullOrEmpty()) a.put("nome", escolhido)
                novos.put(a)
            }
            e.put("arquivos", novos)
            saida.put(e)
        }
        return saida
    }

    fun pastasParaInterface(): JSONArray {
        val saida = JSONArray()
        for (p in listarPastas()) {
            saida.put(JSONObject(p.toString()).put("capa", urlDaCapa(p.optString("capa"))))
        }
        return saida
    }
}
