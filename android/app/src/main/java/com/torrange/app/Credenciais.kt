package com.torrange.app

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * O segredo do aplicativo: o token da conta e o identificador desta instalacao.
 *
 * As regras sao as mesmas do desktop, e por bons motivos:
 *
 *  - o token e uma senha (quem o tem pede acesso a conta inteira), entao e
 *    gravado cifrado pelo cofre do sistema -- aqui, uma chave AES-GCM que vive
 *    dentro do Android Keystore e nunca sai dele -- e NUNCA aparece em log, em
 *    URL, no arquivo de diagnostico ou em mensagem de erro. Para a tela existe
 *    so a forma mascarada;
 *  - o identificador da instalacao TEM de ser estavel: e ele que diz ao site
 *    qual aparelho esta falando, e a conta so aceita tres. Um id novo a cada
 *    abertura gastaria as tres vagas em tres execucoes, entao ele e gravado na
 *    primeira vez e nunca mais muda.
 *
 * O arquivo guarda um cabecalho de uma linha dizendo como o resto foi gravado
 * (`cofre:` ou `claro:`), exatamente como no desktop -- uma leitura nunca
 * confunde os dois formatos.
 */
object Credenciais {

    /** O token do site: 100 caracteres alfanumericos, nao expira. */
    const val TAMANHO_TOKEN = 100

    /**
     * A API aceita de 8 a 64 caracteres em [A-Za-z0-9._:-] no identificador da
     * instalacao e recusa o que passar disso com 400 instalacao_ausente.
     * Usamos o maximo que ela aceita.
     */
    const val TAMANHO_INSTALACAO = 64

    private const val ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    private const val CHAVE = "torrange-token"
    private const val TAMANHO_IV = 12

    private var instalacaoCache: String? = null
    private var tokenCache: String? = null
    private var cofreOk: Boolean? = null

    // ----------------------------------------------------------- instalacao

    private fun sortearId(): String {
        val bytes = ByteArray(TAMANHO_INSTALACAO)
        SecureRandom().nextBytes(bytes)
        val sb = StringBuilder(TAMANHO_INSTALACAO)
        for (b in bytes) sb.append(ALFABETO[(b.toInt() and 0xff) % ALFABETO.length])
        return sb.toString()
    }

    fun idInstalacaoValido(texto: String?): Boolean =
        texto != null && Regex("^[A-Za-z0-9._:-]{8,64}$").matches(texto)

    /** O id deste aparelho. Criado na primeira chamada, estavel para sempre. */
    @Synchronized
    fun idInstalacao(contexto: Context): String {
        instalacaoCache?.let { return it }

        val arquivo = Caminhos.instalacao(contexto)
        try {
            val salvo = JSONObject(arquivo.readText()).optString("id")
            if (idInstalacaoValido(salvo)) {
                instalacaoCache = salvo
                return salvo
            }
        } catch (e: Exception) {
            // primeira execucao, ou arquivo estragado: geramos abaixo
        }

        val novo = sortearId()
        instalacaoCache = novo
        try {
            arquivo.parentFile?.mkdirs()
            arquivo.writeText(
                JSONObject()
                    .put("id", novo)
                    .put("criadoEm", Diagnostico.agora())
                    .toString(2)
            )
        } catch (e: Exception) {
            // Sem gravar, o id muda na proxima abertura e gasta outra vaga das
            // tres da conta -- vale gritar no registro.
            Diagnostico.anotar("erro", "nao consegui gravar o id da instalacao: ${e.message}")
        }
        return novo
    }

    // ---------------------------------------------------------------- token

    fun normalizarToken(texto: String?): String =
        (texto ?: "").replace(Regex("[\\s\"']"), "")

    fun tokenValido(texto: String?): Boolean {
        val limpo = normalizarToken(texto)
        return limpo.length == TAMANHO_TOKEN && Regex("^[A-Za-z0-9]+$").matches(limpo)
    }

    /** Por que este token nao serve -- em portugues, para a tela mostrar. */
    fun motivoDoTokenInvalido(texto: String?): String {
        val limpo = normalizarToken(texto)
        if (limpo.isEmpty()) return "Cole o token que o site mostra em Aplicativos."
        if (!Regex("^[A-Za-z0-9]+$").matches(limpo)) {
            return "O token tem só letras e números — parece que veio texto a mais junto."
        }
        if (limpo.length != TAMANHO_TOKEN) {
            return "O token tem $TAMANHO_TOKEN caracteres; este tem ${limpo.length}. Copie o valor inteiro."
        }
        return ""
    }

    // ------------------------------------------------------------- o cofre

    private fun chaveDoCofre(): SecretKey {
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keystore.getEntry(CHAVE, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val gerador = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gerador.init(
            KeyGenParameterSpec.Builder(
                CHAVE,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Sem exigir tela desbloqueada: o download roda em segundo
                // plano e precisa falar com a API com o aparelho no bolso.
                .setUserAuthenticationRequired(false)
                .build()
        )
        return gerador.generateKey()
    }

    fun cofreDisponivel(): Boolean {
        cofreOk?.let { return it }
        val ok = try {
            chaveDoCofre()
            true
        } catch (e: Exception) {
            Diagnostico.anotar("erro", "cofre do sistema indisponivel: ${e.message}")
            false
        }
        cofreOk = ok
        return ok
    }

    private fun cifrar(texto: String): String {
        val cifra = Cipher.getInstance("AES/GCM/NoPadding")
        cifra.init(Cipher.ENCRYPT_MODE, chaveDoCofre())
        val corpo = cifra.doFinal(texto.toByteArray(Charsets.UTF_8))
        val junto = cifra.iv + corpo
        return Base64.encodeToString(junto, Base64.NO_WRAP)
    }

    private fun decifrar(base64: String): String {
        val junto = Base64.decode(base64, Base64.NO_WRAP)
        val iv = junto.copyOfRange(0, TAMANHO_IV)
        val corpo = junto.copyOfRange(TAMANHO_IV, junto.size)
        val cifra = Cipher.getInstance("AES/GCM/NoPadding")
        cifra.init(Cipher.DECRYPT_MODE, chaveDoCofre(), GCMParameterSpec(128, iv))
        return String(cifra.doFinal(corpo), Charsets.UTF_8)
    }

    // ---------------------------------------------------------- leitura e escrita

    @Synchronized
    fun lerToken(contexto: Context): String {
        tokenCache?.let { return it }

        val arquivo = Caminhos.token(contexto)
        val bruto = try {
            arquivo.readText()
        } catch (e: Exception) {
            tokenCache = ""
            return ""
        }

        val corte = bruto.indexOf(':')
        val formato = if (corte > 0) bruto.substring(0, corte) else ""
        val conteudo = if (corte > 0) bruto.substring(corte + 1) else ""

        tokenCache = when (formato) {
            "cofre" -> try {
                decifrar(conteudo)
            } catch (e: Exception) {
                // Chave perdida (dados restaurados noutro aparelho, cofre
                // recriado): o token nao volta. Pedir de novo e o certo.
                Diagnostico.anotar("erro", "nao consegui decifrar o token guardado: ${e.message}")
                ""
            }
            "claro" -> normalizarToken(conteudo)
            else -> ""
        }
        return tokenCache!!
    }

    @Synchronized
    fun gravarToken(contexto: Context, texto: String): Boolean {
        val limpo = normalizarToken(texto)
        if (!tokenValido(limpo)) throw IllegalArgumentException(motivoDoTokenInvalido(limpo))

        val arquivo = Caminhos.token(contexto)
        arquivo.parentFile?.mkdirs()

        val protegido = cofreDisponivel()
        val conteudo = if (protegido) {
            try {
                "cofre:" + cifrar(limpo)
            } catch (e: Exception) {
                cofreOk = false
                "claro:$limpo"
            }
        } else {
            "claro:$limpo"
        }
        arquivo.writeText(conteudo)
        // A pasta de dados do aplicativo ja e privada; isto e cinto e
        // suspensorio para o caso de um aparelho com raiz aberta.
        arquivo.setReadable(false, false)
        arquivo.setReadable(true, true)
        arquivo.setWritable(false, false)
        arquivo.setWritable(true, true)

        tokenCache = limpo
        return cofreDisponivel()
    }

    @Synchronized
    fun apagarToken(contexto: Context) {
        tokenCache = ""
        try {
            Caminhos.token(contexto).delete()
        } catch (e: Exception) {
            // ja nao existia
        }
    }

    fun temToken(contexto: Context): Boolean = lerToken(contexto).isNotEmpty()

    /** 4kP9…c2Za -- o suficiente para o dono conferir que e o token certo. */
    fun mascarar(contexto: Context, texto: String? = null): String {
        val limpo = normalizarToken(texto ?: lerToken(contexto))
        if (limpo.isEmpty()) return ""
        return if (limpo.length <= 12) {
            "${limpo.take(2)}…${limpo.takeLast(2)}"
        } else {
            "${limpo.take(4)}…${limpo.takeLast(4)}"
        }
    }

    /** O que a tela e o diagnostico podem ver. Nunca o token em si. */
    fun resumo(contexto: Context): JSONObject {
        val tem = temToken(contexto)
        return JSONObject()
            .put("temToken", tem)
            .put("tokenMascarado", if (tem) mascarar(contexto) else "")
            .put("protegidoPeloCofre", if (tem) cofreDisponivel() else JSONObject.NULL)
            .put("instalacao", idInstalacao(contexto))
    }

    /** Aparece no diagnostico para explicar onde o token foi parar. */
    fun descricaoDoCofre(): String =
        if (cofreDisponivel()) {
            "Android Keystore (AES-GCM, chave nao exportavel)" +
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) " — com StrongBox quando o aparelho tem" else ""
        } else {
            "sem cofre: arquivo em texto puro na area privada do aplicativo"
        }
}
