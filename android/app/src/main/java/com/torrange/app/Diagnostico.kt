package com.torrange.app

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Modo diagnostico: junta num unico arquivo .log tudo o que costuma explicar um
 * problema relatado -- versoes, caminhos, a sessao da libtorrent, o que o
 * player registrou, a fila e tudo o que o aplicativo anotou desde que abriu.
 *
 * O registro comeca na subida do aplicativo, nao na hora em que alguem pede o
 * arquivo -- senao a parte mais importante, que e justamente a subida, ja teria
 * passado.
 */
object Diagnostico {

    private const val MAX_LINHAS = 2000
    private val linhas = ArrayDeque<String>()

    fun agora(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).format(Date())

    @Synchronized
    fun anotar(origem: String, texto: String?) {
        val limpo = (texto ?: "").trimEnd()
        if (limpo.isEmpty()) return
        for (parte in limpo.split("\n")) {
            linhas.addLast("${agora()} [$origem] $parte")
        }
        while (linhas.size > MAX_LINHAS) linhas.removeFirst()
        Log.i("torrange", "[$origem] ${limpo.lineSequence().first()}")
    }

    fun anotarErro(origem: String, erro: Throwable) {
        anotar(origem, Log.getStackTraceString(erro))
    }

    /** Nada escapa em silencio: uma excecao solta tambem entra no registro. */
    fun capturarExcecoes() {
        val anterior = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { linha, erro ->
            anotar("excecao", Log.getStackTraceString(erro))
            anterior?.uncaughtException(linha, erro)
        }
    }

    @Synchronized
    fun registro(): List<String> = linhas.toList()

    // ------------------------------------------------------------- relatorio

    private fun secao(titulo: String) = "\n${"=".repeat(72)}\n== $titulo\n${"=".repeat(72)}\n"

    private fun comoTexto(valor: Any?): String = try {
        when (valor) {
            null -> "null"
            is JSONObject -> valor.toString(2)
            is JSONArray -> valor.toString(2)
            else -> valor.toString()
        }
    } catch (e: Exception) {
        "<nao consegui serializar: ${e.message}>"
    }

    private fun olharPasta(pasta: File): JSONObject = JSONObject()
        .put("caminho", pasta.absolutePath)
        .put("existe", pasta.exists())
        .put("gravavel", pasta.canWrite())
        .put("arquivos", (pasta.listFiles()?.size ?: -1))
        .put("livre", legivel(Caminhos.espacoLivre(pasta)))
        .put("total", legivel(try { pasta.totalSpace } catch (e: Exception) { -1L }))

    private fun legivel(bytes: Long): String =
        if (bytes < 0) "?" else String.format(Locale.US, "%.1f GB", bytes / 1024.0 / 1024.0 / 1024.0)

    /**
     * Monta o relatorio inteiro. Recebe as pecas de fora para nao criar
     * dependencia circular com o nucleo.
     */
    fun montar(contexto: Context, fontes: JSONObject): String {
        val partes = mutableListOf<String>()

        partes.add("Diagnóstico do Torrange (Android)")
        partes.add("gerado em ${agora()}")

        partes.add(secao("Aplicação e sistema"))
        partes.add(
            comoTexto(
                JSONObject()
                    .put("versao", BuildConfig.VERSION_NAME)
                    .put("versaoCodigo", BuildConfig.VERSION_CODE)
                    .put("pacote", contexto.packageName)
                    .put("android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                    .put("aparelho", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("arquiteturas", JSONArray(Build.SUPPORTED_ABIS.toList()))
                    .put("idioma", Locale.getDefault().toString())
                    .put("webview", fontes.opt("webview"))
            )
        )

        partes.add(secao("Caminhos"))
        partes.add(
            comoTexto(
                JSONObject()
                    .put("dadosDoApp", olharPasta(contexto.filesDir))
                    .put("downloads", olharPasta(File(fontes.optJSONObject("config")?.optString("pastaDownloads") ?: contexto.filesDir.path)))
                    .put("capas", olharPasta(Caminhos.capas(contexto)))
                    .put("torrents", olharPasta(Caminhos.torrents(contexto)))
            )
        )

        partes.add(secao("Configuração"))
        // A senha de Ajustes fica de fora: este arquivo nasceu para ser
        // anexado num relato de problema.
        val cfg = JSONObject(fontes.optJSONObject("config")?.toString() ?: "{}")
        if (cfg.optString("qbitSenha").isNotEmpty()) cfg.put("qbitSenha", "<definida, omitida daqui>")
        partes.add(comoTexto(cfg))

        partes.add(secao("Conexão com o site"))
        // O TOKEN NUNCA ENTRA AQUI -- so a forma mascarada, que serve para
        // conferir qual token e sem entregar a conta a quem ler o arquivo.
        partes.add(comoTexto(fontes.opt("conexao")))
        partes.add("\ncofre: ${Credenciais.descricaoDoCofre()}")

        partes.add(secao("Motor de torrent (libtorrent embutida)"))
        partes.add(comoTexto(fontes.opt("motor")))
        partes.add("\n-- o que a sessão registrou --")
        val registroMotor = fontes.optJSONArray("registroMotor")
        partes.add(
            if (registroMotor != null && registroMotor.length() > 0) {
                (0 until registroMotor.length()).joinToString("\n") { registroMotor.optString(it) }
            } else "(nada)"
        )

        partes.add(secao("Player (libVLC)"))
        partes.add(comoTexto(fontes.opt("player")))

        partes.add(secao("Fila de downloads"))
        val fila = fontes.optJSONArray("fila") ?: JSONArray()
        partes.add(
            if (fila.length() == 0) "(vazia)" else comoTexto(
                JSONArray().also { saida ->
                    for (i in 0 until fila.length()) {
                        val t = fila.optJSONObject(i) ?: continue
                        saida.put(
                            JSONObject()
                                .put("nome", t.optString("name"))
                                .put("estado", t.optString("state"))
                                .put("progresso", String.format(Locale.US, "%.1f%%", t.optDouble("progress", 0.0) * 100))
                                .put("tamanho", t.optLong("size"))
                                .put("seeds", t.optInt("num_seeds"))
                                .put("pasta", t.optString("save_path"))
                        )
                    }
                }
            )
        )

        partes.add(secao("Biblioteca"))
        val biblioteca = fontes.optJSONArray("biblioteca") ?: JSONArray()
        partes.add("${biblioteca.length()} entrada(s)")
        if (biblioteca.length() > 0) {
            val saida = JSONArray()
            for (i in 0 until minOf(50, biblioteca.length())) {
                val e = biblioteca.optJSONObject(i) ?: continue
                saida.put(
                    JSONObject()
                        .put("nome", e.optString("nome"))
                        .put("reproduzivel", e.optBoolean("reproduzivel"))
                        .put("arquivos", e.optJSONArray("arquivos")?.length() ?: 0)
                )
            }
            partes.add(comoTexto(saida))
        }

        partes.add(secao("Tela"))
        partes.add(comoTexto(fontes.opt("tela")))

        partes.add(secao("Registro do app (mais recente por último)"))
        val r = registro()
        partes.add(if (r.isEmpty()) "(nada registrado)" else r.joinToString("\n"))

        return partes.joinToString("\n")
    }

    /** Escreve o relatorio e devolve o caminho. */
    fun salvar(contexto: Context, destino: File, fontes: JSONObject): JSONObject {
        val texto = montar(contexto, fontes)
        destino.parentFile?.mkdirs()
        destino.writeText(texto)
        return JSONObject()
            .put("caminho", destino.absolutePath)
            .put("bytes", texto.toByteArray(Charsets.UTF_8).size)
    }

    /** torrange-diagnostico-2026-09-10_20-31-05.log */
    fun nomeSugerido(): String =
        "torrange-diagnostico-" +
            SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date()) + ".log"
}
