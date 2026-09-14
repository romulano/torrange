package com.torrange.app

import android.content.Context
import android.system.Os
import org.json.JSONObject
import java.io.File

/**
 * Dá ao OpenSSL de dentro da libtorrent o cofre de certificados do Android.
 *
 * O tracker do site é `https://`, e quem fala HTTPS dentro do motor de torrent
 * é um OpenSSL que vem compilado junto com a biblioteca nativa. Esse OpenSSL
 * foi compilado noutra máquina, e os caminhos de certificado que ele traz de
 * fábrica são os de lá:
 *
 *     /home/runner/work/libtorrent4j/libtorrent4j/openssl-3.5.5/../openssl/ssl/cert.pem
 *     /home/runner/work/libtorrent4j/libtorrent4j/openssl-3.5.5/../openssl/ssl/certs
 *
 * No telefone esses caminhos não existem. Sem nenhuma autoridade certificadora
 * para conferir, a conexão com o tracker morre no aperto de mão do TLS -- antes
 * de qualquer resposta. O resultado na tela é um torrent que fica em "baixando"
 * com "sem seeds" e zero explicação: o tracker nunca chegou a responder nada,
 * então não há mensagem de erro dele para mostrar.
 *
 * O conserto não é desligar a conferência: é apontar o OpenSSL para o cofre que
 * o próprio Android já tem. Ele lê as variáveis SSL_CERT_FILE e SSL_CERT_DIR
 * (as duas estão no binário), e o Android guarda os certificados em pastas
 * legíveis, no mesmo formato PEM que o OpenSSL espera.
 *
 * Se não der para montar o cofre, quem chama decide o que fazer -- e a decisão
 * fica registrada no diagnóstico, em vez de virar um download mudo.
 */
object Certificados {

    /** Onde o Android guarda as autoridades certificadoras. */
    private val PASTAS = listOf(
        "/apex/com.android.conscrypt/cacerts", // Android 14 em diante
        "/system/etc/security/cacerts"         // o caminho de sempre
    )

    private const val INICIO = "-----BEGIN CERTIFICATE-----"
    private const val FIM = "-----END CERTIFICATE-----"

    private var relatorio = JSONObject().put("preparado", false)

    fun relatorio(): JSONObject = relatorio

    /**
     * Monta o cofre e aponta o OpenSSL para ele. Devolve true quando deu certo.
     * Chame ANTES de subir a sessão: o OpenSSL lê as variáveis quando cria o
     * primeiro contexto TLS.
     */
    @Synchronized
    fun preparar(contexto: Context): Boolean {
        val pasta = PASTAS.map(::File).firstOrNull { pasta ->
            try {
                pasta.isDirectory && (pasta.listFiles()?.isNotEmpty() == true)
            } catch (e: Exception) {
                false
            }
        }

        if (pasta == null) {
            relatorio = JSONObject()
                .put("preparado", false)
                .put("motivo", "não achei o cofre de certificados do sistema")
                .put("procurei", PASTAS.joinToString(", "))
            Diagnostico.anotar("certificados", "nenhum cofre do sistema encontrado em: ${PASTAS.joinToString(", ")}")
            return false
        }

        return try {
            val destino = File(contexto.filesDir, "cacert.pem")
            val quantos = if (precisaGerar(destino, pasta)) juntar(pasta, destino) else contar(destino)

            if (quantos == 0) throw Exception("o cofre do sistema não tinha nenhum certificado legível")

            // O arquivo é o que vale; a pasta vai junto como segunda chance,
            // para o caso de o OpenSSL preferir a busca por hash.
            Os.setenv("SSL_CERT_FILE", destino.absolutePath, true)
            Os.setenv("SSL_CERT_DIR", pasta.absolutePath, true)

            relatorio = JSONObject()
                .put("preparado", true)
                .put("origem", pasta.absolutePath)
                .put("arquivo", destino.absolutePath)
                .put("certificados", quantos)
            Diagnostico.anotar("certificados", "$quantos certificados de ${pasta.absolutePath}")
            true
        } catch (e: Throwable) {
            relatorio = JSONObject()
                .put("preparado", false)
                .put("motivo", e.message ?: e.toString())
                .put("origem", pasta.absolutePath)
            Diagnostico.anotar("certificados", "não consegui montar o cofre: ${e.message}")
            false
        }
    }

    private fun precisaGerar(destino: File, origem: File): Boolean =
        !destino.exists() || destino.length() == 0L || destino.lastModified() < origem.lastModified()

    /**
     * Junta tudo num PEM só.
     *
     * Os arquivos do Android trazem o certificado em PEM seguido de uma
     * descrição em texto; só a parte entre BEGIN e END interessa ao OpenSSL.
     */
    private fun juntar(origem: File, destino: File): Int {
        var quantos = 0
        destino.bufferedWriter().use { saida ->
            for (arquivo in origem.listFiles().orEmpty()) {
                if (!arquivo.isFile) continue
                val texto = try {
                    arquivo.readText()
                } catch (e: Exception) {
                    continue
                }
                var de = texto.indexOf(INICIO)
                while (de >= 0) {
                    val ate = texto.indexOf(FIM, de)
                    if (ate < 0) break
                    saida.write(texto.substring(de, ate + FIM.length))
                    saida.write("\n")
                    quantos++
                    de = texto.indexOf(INICIO, ate)
                }
            }
        }
        return quantos
    }

    private fun contar(arquivo: File): Int = try {
        arquivo.readText().split(INICIO).size - 1
    } catch (e: Exception) {
        0
    }
}
