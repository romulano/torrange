package com.torrange.app

import android.content.Context
import org.json.JSONObject

/**
 * Ajustes do aplicativo -- o mesmo config.json do desktop, com os mesmos nomes
 * de campo, porque e a interface (que e a mesma) quem os le e escreve.
 *
 * Dois campos herdados nao valem no Android e ficam aqui so para a interface
 * nao quebrar: `qbitUsuario`/`qbitSenha` (nao existe WebUI para entrar) e
 * `videoEmJanelaSeparada` (o video sempre fica acoplado a area da tela). A
 * tela de Ajustes esconde os dois.
 */
class Config(private val contexto: Context) {

    private var cache: JSONObject? = null

    fun padroes(): JSONObject = JSONObject().apply {
        put("siteUrl", "https://torrange.com/")
        put("apiUrl", "https://torrange.com/api/aplicativo")
        put("nomeDoAparelho", "")
        put("pastaDownloads", Caminhos.downloadsPadrao(contexto).absolutePath)
        put("downloadSequencial", true)
        put("videoEmJanelaSeparada", false)
        put("limiteDownload", 0)
        put("limiteUpload", 0)
        put("volume", 100)
        put("qbitUsuario", "")
        put("qbitSenha", "")
        // So no Android: baixar tambem com a tela apagada. Desligado, a
        // sessao e suspensa quando o aplicativo sai da frente.
        put("baixarEmSegundoPlano", true)
    }

    @Synchronized
    fun ler(): JSONObject {
        cache?.let { return it }
        val base = padroes()
        val arquivo = Caminhos.config(contexto)
        if (arquivo.exists()) {
            try {
                val salvo = JSONObject(arquivo.readText())
                for (chave in salvo.keys()) base.put(chave, salvo.get(chave))
            } catch (e: Exception) {
                Diagnostico.anotar("config", "arquivo ilegivel, usando os padroes: ${e.message}")
            }
        }
        cache = base
        return base
    }

    @Synchronized
    fun gravar(parcial: JSONObject?): JSONObject {
        val atual = ler()
        if (parcial != null) {
            for (chave in parcial.keys()) atual.put(chave, parcial.get(chave))
        }
        val arquivo = Caminhos.config(contexto)
        arquivo.parentFile?.mkdirs()
        arquivo.writeText(atual.toString(2))
        cache = atual
        return atual
    }

    fun texto(chave: String): String = ler().optString(chave, "")
    fun numero(chave: String): Int = ler().optInt(chave, 0)
    fun ligado(chave: String): Boolean = ler().optBoolean(chave, false)

    fun pastaDownloads() = Caminhos.garantir(java.io.File(texto("pastaDownloads")))
}
