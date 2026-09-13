package com.torrange.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Biblioteca: cruza o que o motor de torrent esta baixando com os arquivos de
 * video em disco e guarda o estado de reproducao (posicao, ultimo arquivo
 * assistido).
 *
 * O catalogo e persistido para que um titulo continue disponivel no player
 * mesmo se o usuario remover o torrent da fila mantendo os arquivos.
 */
class Biblioteca(private val contexto: Context, private val motor: Motor) {

    companion object {
        private val EXT_VIDEO = setOf(
            "mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "m2ts",
            "wmv", "flv", "mpg", "mpeg", "ogv", "3gp", "vob", "divx"
        )
        private val EXT_LEGENDA = setOf("srt", "ass", "ssa", "sub", "idx", "vtt")

        fun ehVideo(nome: String) = EXT_VIDEO.contains(nome.substringAfterLast('.', "").lowercase())
        fun ehLegenda(nome: String) = EXT_LEGENDA.contains(nome.substringAfterLast('.', "").lowercase())
    }

    private var catalogo: JSONObject? = null
    private var ultimoSnapshot: List<JSONObject> = emptyList()
    private val cacheArquivos = HashMap<String, Pair<Double, List<JSONObject>>>()
    private var gravacaoPendente = false

    @Synchronized
    private fun carregar(): JSONObject {
        catalogo?.let { return it }
        val lido = try {
            JSONObject(Caminhos.biblioteca(contexto).readText())
        } catch (e: Exception) {
            JSONObject()
        }
        catalogo = lido
        return lido
    }

    @Synchronized
    private fun gravar() {
        if (gravacaoPendente) return
        gravacaoPendente = true
        // Agrupa as gravacoes: o monitor roda a cada segundo e nao vale
        // reescrever o arquivo inteiro a cada volta.
        Thread {
            Thread.sleep(400)
            synchronized(this) {
                gravacaoPendente = false
                try {
                    Caminhos.biblioteca(contexto).writeText(carregar().toString())
                } catch (e: Exception) {
                    Diagnostico.anotar("erro", "falha ao gravar a biblioteca: ${e.message}")
                }
            }
        }.start()
    }

    /**
     * Le a lista de arquivos de um torrent. Evita perguntar ao motor a cada
     * ciclo: so rele enquanto o download nao terminou.
     */
    private fun arquivosDoTorrent(t: JSONObject): List<JSONObject> {
        val hash = t.optString("hash")
        val progresso = t.optDouble("progress", 0.0)
        val cache = cacheArquivos[hash]
        if (cache != null && cache.first >= 1.0 && progresso >= 1.0) return cache.second

        val brutos = try {
            motor.arquivosDe(hash)
        } catch (e: Exception) {
            return cache?.second ?: emptyList()
        }

        val pasta = t.optString("save_path")
        val arquivos = brutos.map { a ->
            val relativo = a.optString("name")
            val nome = relativo.substringAfterLast('/')
            JSONObject()
                .put("nome", nome)
                .put("relativo", relativo)
                .put("caminho", File(pasta, relativo).absolutePath)
                .put("tamanho", a.optLong("size"))
                .put("progresso", a.optDouble("progress", 0.0))
                .put("indice", a.optInt("index"))
                .put("video", ehVideo(nome))
                .put("legenda", ehLegenda(nome))
        }
        cacheArquivos[hash] = Pair(progresso, arquivos)
        return arquivos
    }

    /** Escolhe o video principal: o maior arquivo de video do torrent. */
    private fun principalDe(arquivos: List<JSONObject>): JSONObject? =
        arquivos.filter { it.optBoolean("video") }.maxByOrNull { it.optLong("tamanho") }

    /** Roda a cada ciclo do monitor: atualiza o catalogo com o estado do motor. */
    @Synchronized
    fun sincronizar(): JSONArray {
        val catalogo = carregar()
        val torrents = motor.listar()
        ultimoSnapshot = torrents
        var mudou = false

        for (t in torrents) {
            val hash = t.optString("hash")
            val arquivos = arquivosDoTorrent(t)
            val videos = arquivos.filter { it.optBoolean("video") }
            val progresso = t.optDouble("progress", 0.0)
            if (videos.isEmpty() && progresso < 1.0) continue // ainda sem saber o conteudo

            val anterior = catalogo.optJSONObject(hash) ?: JSONObject()
            val concluido = progresso >= 1.0

            val entrada = JSONObject(anterior.toString())
                .put("hash", hash)
                .put("nome", t.optString("name"))
                .put("savePath", t.optString("save_path"))
                .put("contentPath", t.optString("content_path"))
                .put("tamanho", t.optLong("size"))
                .put(
                    "adicionadoEm",
                    if (anterior.has("adicionadoEm") && anterior.optLong("adicionadoEm") > 0)
                        anterior.optLong("adicionadoEm") else t.optLong("added_on") * 1000
                )
                .put(
                    "concluidoEm",
                    if (concluido) {
                        if (anterior.optLong("concluidoEm") > 0) anterior.optLong("concluidoEm")
                        else if (t.optLong("completion_on") > 0) t.optLong("completion_on") * 1000
                        else System.currentTimeMillis()
                    } else JSONObject.NULL
                )
                .put("arquivos", JSONArray().apply {
                    for (v in videos) {
                        put(
                            JSONObject()
                                .put("nome", v.optString("nome"))
                                .put("relativo", v.optString("relativo"))
                                .put("caminho", v.optString("caminho"))
                                .put("tamanho", v.optLong("tamanho"))
                                .put("progresso", v.optDouble("progresso"))
                        )
                    }
                })
                .put("legendas", JSONArray().apply {
                    for (a in arquivos) if (a.optBoolean("legenda")) put(a.optString("caminho"))
                })
                .put("principal", principalDe(arquivos)?.optString("caminho") ?: JSONObject.NULL)
                .put("posicoes", anterior.optJSONObject("posicoes") ?: JSONObject())

            catalogo.put(hash, entrada)
            mudou = true
        }

        // remove do catalogo o que sumiu do disco e nao esta mais na fila
        val naFila = torrents.map { it.optString("hash") }.toSet()
        for (hash in catalogo.keys().asSequence().toList()) {
            if (naFila.contains(hash)) continue
            val e = catalogo.optJSONObject(hash) ?: continue
            val arquivos = e.optJSONArray("arquivos") ?: JSONArray()
            var existe = false
            for (i in 0 until arquivos.length()) {
                if (File(arquivos.optJSONObject(i).optString("caminho")).exists()) {
                    existe = true
                    break
                }
            }
            if (!existe) {
                catalogo.remove(hash)
                mudou = true
            }
        }

        if (mudou) gravar()
        return listar()
    }

    /** Catalogo enriquecido com o estado ao vivo do download. */
    @Synchronized
    fun listar(): JSONArray {
        val catalogo = carregar()
        val porHash = ultimoSnapshot.associateBy { it.optString("hash") }

        val entradas = mutableListOf<JSONObject>()
        for (hash in catalogo.keys()) {
            val e = catalogo.optJSONObject(hash) ?: continue
            val t = porHash[hash]
            val progresso = t?.optDouble("progress", 0.0) ?: 1.0

            val arquivos = JSONArray()
            var algumExiste = false
            val brutos = e.optJSONArray("arquivos") ?: JSONArray()
            for (i in 0 until brutos.length()) {
                val a = JSONObject(brutos.optJSONObject(i).toString())
                val existe = File(a.optString("caminho")).exists()
                if (existe) algumExiste = true
                arquivos.put(a.put("existe", existe))
            }

            entradas.add(
                JSONObject(e.toString())
                    .put("arquivos", arquivos)
                    .put("progresso", progresso)
                    .put("estado", t?.optString("state") ?: "arquivado")
                    .put("velocidade", t?.optLong("dlspeed") ?: 0L)
                    .put("eta", t?.optLong("eta") ?: 0L)
                    .put("seeds", t?.optInt("num_seeds") ?: 0)
                    .put("naFila", t != null)
                    // pronto = download concluido; reproduzivel = da para comecar a assistir
                    .put("pronto", progresso >= 1.0)
                    .put("reproduzivel", algumExiste && (progresso >= 1.0 || progresso > 0.015))
            )
        }

        entradas.sortByDescending {
            val concluido = it.optLong("concluidoEm")
            if (concluido > 0) concluido else it.optLong("adicionadoEm")
        }

        val saida = JSONArray()
        for (e in entradas) saida.put(e)
        return saida
    }

    @Synchronized
    fun obter(hash: String): JSONObject? = carregar().optJSONObject(hash)

    /** Guarda onde o usuario parou de assistir. */
    @Synchronized
    fun salvarPosicao(hash: String, caminho: String, segundos: Double, duracao: Double) {
        val e = carregar().optJSONObject(hash) ?: return
        val posicoes = e.optJSONObject("posicoes") ?: JSONObject().also { e.put("posicoes", it) }
        // perto do fim, considera assistido e zera a marcacao
        if (duracao > 0 && segundos > duracao - 60) {
            posicoes.remove(caminho)
        } else {
            posicoes.put(
                caminho,
                JSONObject()
                    .put("segundos", segundos)
                    .put("duracao", duracao)
                    .put("em", System.currentTimeMillis())
            )
        }
        e.put("ultimoArquivo", caminho)
        gravar()
    }

    @Synchronized
    fun posicaoDe(hash: String, caminho: String): Double =
        obter(hash)?.optJSONObject("posicoes")?.optJSONObject(caminho)?.optDouble("segundos", 0.0) ?: 0.0

    /** Ultima resposta crua do motor (usada pela aba de downloads). */
    @Synchronized
    fun snapshot(): JSONArray {
        val saida = JSONArray()
        for (t in ultimoSnapshot) saida.put(t)
        return saida
    }
}
