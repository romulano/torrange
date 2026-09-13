package com.torrange.app

import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * O estado da conversa com o site: do token colado ate o aparelho autorizado.
 *
 * A sequencia e a da especificacao, e cada passo depende do anterior:
 *
 *   sem-token   o usuario ainda nao colou nada        -> tela do token
 *   conectando  apresentando o aparelho (/conexao)
 *   pendente    a vaga existe e espera o dono clicar  -> tela de espera
 *   aprovado    todas as rotas respondem
 *   erro        token trocado, assinatura vencida, sem vaga, sem rede...
 *
 * Duas coisas valem repetir, porque sao justamente onde e facil errar:
 *
 *  1. "aguardando_aprovacao" e ESTADO, nao erro. Uma tela dizendo "abra o site
 *     e permita este aparelho" resolve; uma mensagem de falha manda o usuario
 *     reinstalar a toa.
 *  2. Nao se repete /conexao em laco. A vaga ja esta guardada e o teto e de 10
 *     chamadas por minuto -- quem espera e o GET /conta, que custa pouco.
 */
class Conexao(
    private val contexto: Context,
    private val api: Api,
    private val escopo: CoroutineScope,
    private val aoEstado: (JSONObject) -> Unit
) {

    companion object {
        /** De quanto em quanto tempo perguntamos se a autorizacao saiu (limite: 60/min). */
        const val INTERVALO_ESPERA = 5_000L

        /** Sem rede, espacamos mais: nao adianta martelar um servidor que nao responde. */
        const val INTERVALO_SEM_REDE = 15_000L

        /** Piso entre dois POST /conexao (limite: 10/min). */
        const val INTERVALO_CONEXAO = 30_000L
    }

    private class Recusa(val fase: String, val texto: String, val refazerConexao: Boolean = false)

    /**
     * O que cada codigo de erro significa para o aplicativo. `fase` diz para
     * onde a tela vai; `refazerConexao` marca os casos em que a vaga precisa
     * ser pedida de novo.
     */
    private val recusas = mapOf(
        "token_ausente" to Recusa("sem-token", "Nenhum token cadastrado neste aplicativo."),
        "token_invalido" to Recusa(
            "sem-token",
            "Este token não vale mais — em geral porque um novo foi gerado no site. Cole o token atual."
        ),
        "conta_inativa" to Recusa(
            "erro",
            "Esta conta foi removida. Não adianta tentar de novo: fale com o site."
        ),
        "assinatura_inativa" to Recusa(
            "erro",
            "A assinatura não está em dia. Resolva no site e volte aqui."
        ),
        "instalacao_ausente" to Recusa(
            "erro",
            "O identificador deste aparelho foi recusado. Gere um novo em Ajustes."
        ),
        "nao_conectado" to Recusa(
            "conectando",
            "Este aparelho não tem vaga na conta. Apresentando de novo…",
            refazerConexao = true
        ),
        "aguardando_aprovacao" to Recusa(
            "pendente",
            "Este aplicativo ainda não foi autorizado. Abra o site e permita o acesso."
        ),
        "sem_vaga" to Recusa(
            "erro",
            "Esta conta já tem três aplicativos. Remova um no site para abrir vaga."
        ),
        "muitas_chamadas" to Recusa("pendente", "Muitas chamadas seguidas. Esperando um pouco…"),
        "sem_rede" to Recusa("pendente", "Sem resposta do site. Tentando de novo…")
    )

    private var estado = JSONObject()
        .put("fase", "sem-token")
        .put("erro", "")
        .put("mensagem", "")
        .put("conta", JSONObject.NULL)
        .put("gemas", JSONObject.NULL)
        .put("aplicativo", JSONObject.NULL)
        .put("verificadoEm", JSONObject.NULL)

    private var urlDoSite = "https://torrange.com/"
    private var ultimaConexao = 0L
    private var ocupado = false
    private var espera: Job? = null

    // -------------------------------------------------------------- estado

    @Synchronized
    private fun publicar(parcial: JSONObject) {
        for (chave in parcial.keys()) estado.put(chave, parcial.get(chave))
        val resumo = Credenciais.resumo(contexto)
        for (chave in resumo.keys()) estado.put(chave, resumo.get(chave))
        aoEstado(atual())
    }

    @Synchronized
    fun atual(): JSONObject {
        val copia = JSONObject(estado.toString())
        copia.put("pronto", estado.optString("fase") == "aprovado")
        copia.put("paginaAplicativos", paginaAplicativos())
        return copia
    }

    fun paginaAplicativos(): String = try {
        urlDoSite.trimEnd('/') + "/aplicativos"
    } catch (e: Exception) {
        "https://torrange.com/aplicativos"
    }

    /** Nome que o dono le ao lado do botao Permitir. 2 a 80 caracteres. */
    fun nomeDoAparelho(config: Config): String {
        val escolhido = config.texto("nomeDoAparelho").trim()
        if (escolhido.length >= 2) return escolhido.take(80)
        val aparelho = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        val base = if (aparelho.length >= 2) "Torrange · $aparelho" else "Torrange Android"
        return base.take(80)
    }

    private fun plataforma(): String = "Android ${Build.VERSION.RELEASE}".take(40)

    // -------------------------------------------------- traducao das recusas

    private fun codigoDe(erro: Throwable): String = when (erro) {
        is ErroApi -> erro.erro
        is ErroRede -> erro.erro
        else -> ""
    }

    private fun traduzir(erro: Throwable): Pair<String, Recusa> {
        val codigo = codigoDe(erro)
        recusas[codigo]?.let { return Pair(codigo, it) }
        return Pair(
            codigo.ifEmpty { "falha" },
            Recusa("erro", erro.message ?: "Não consegui falar com o site.")
        )
    }

    // --------------------------------------------------------------- passos

    /** Apresenta o aparelho. Respeita o piso entre duas chamadas. */
    private fun apresentar(config: Config, forcar: Boolean = false): JSONObject? {
        val agora = System.currentTimeMillis()
        if (!forcar && agora - ultimaConexao < INTERVALO_CONEXAO) return null
        ultimaConexao = agora
        return api.conexao(nomeDoAparelho(config), plataforma())
    }

    /**
     * Uma volta completa: apresenta (se preciso) e confere a conta.
     * Devolve a fase em que parou. Chame de uma linha de IO.
     */
    fun verificar(config: Config, apresentando: Boolean = false): String {
        synchronized(this) {
            if (ocupado) return estado.optString("fase")
            ocupado = true
        }
        try {
            if (!Credenciais.temToken(contexto)) {
                publicar(
                    JSONObject().put("fase", "sem-token").put("erro", "").put("mensagem", "")
                        .put("conta", JSONObject.NULL).put("gemas", JSONObject.NULL)
                )
                return "sem-token"
            }

            if (apresentando) {
                publicar(
                    JSONObject().put("fase", "conectando").put("erro", "")
                        .put("mensagem", "Apresentando este aparelho ao site…")
                )
                val r = apresentar(config, forcar = true)
                if (r != null && r.optString("estado") == "pendente") {
                    publicar(
                        JSONObject()
                            .put("fase", "pendente")
                            .put("erro", "aguardando_aprovacao")
                            .put(
                                "mensagem",
                                r.optString("mensagem").ifEmpty { recusas["aguardando_aprovacao"]!!.texto }
                            )
                            .put("aplicativo", r.opt("aplicativo") ?: JSONObject.NULL)
                            .put("vagasLivres", r.opt("vagas_livres") ?: JSONObject.NULL)
                    )
                    return "pendente"
                }
            }

            val dados = api.conta()
            publicar(
                JSONObject()
                    .put("fase", "aprovado")
                    .put("erro", "")
                    .put("mensagem", "")
                    .put("conta", dados.opt("conta") ?: JSONObject.NULL)
                    .put("gemas", dados.opt("gemas") ?: JSONObject.NULL)
                    .put("aplicativo", dados.opt("aplicativo") ?: JSONObject.NULL)
                    .put("verificadoEm", Diagnostico.agora())
            )
            return "aprovado"
        } catch (erro: Throwable) {
            return tratarFalha(erro, config)
        } finally {
            synchronized(this) { ocupado = false }
        }
    }

    private fun tratarFalha(erro: Throwable, config: Config, profundidade: Int = 0): String {
        val (codigo, t) = traduzir(erro)

        // "Este aparelho nunca se apresentou" tem conserto sozinho: pede a vaga.
        if (t.refazerConexao && profundidade < 2) {
            try {
                val r = apresentar(config)
                if (r != null) {
                    val pendente = r.optString("estado") != "aprovado"
                    publicar(
                        JSONObject()
                            .put("fase", if (pendente) "pendente" else "aprovado")
                            .put("erro", if (pendente) "aguardando_aprovacao" else "")
                            .put(
                                "mensagem",
                                if (pendente) r.optString("mensagem")
                                    .ifEmpty { recusas["aguardando_aprovacao"]!!.texto } else ""
                            )
                            .put("aplicativo", r.opt("aplicativo") ?: JSONObject.NULL)
                    )
                    return if (pendente) "pendente" else "aprovado"
                }
            } catch (outro: Throwable) {
                return tratarFalha(outro, config, profundidade + 1)
            }
        }

        if (t.fase == "sem-token" && codigo == "token_invalido") {
            // O token morreu: guardar um token morto so faz o app falhar em silencio.
            Credenciais.apagarToken(contexto)
        }

        publicar(JSONObject().put("fase", t.fase).put("erro", codigo).put("mensagem", t.texto))
        return t.fase
    }

    // --------------------------------------------------------- laco de espera

    private fun pararEspera() {
        espera?.cancel()
        espera = null
    }

    /**
     * Enquanto a autorizacao nao sai, perguntamos de tempos em tempos. Uma
     * corrotina encadeada (e nao um timer) garante que duas voltas nunca se
     * atropelem quando o servidor demora.
     */
    private fun agendarEspera(config: Config) {
        pararEspera()
        val fase = estado.optString("fase")
        if (fase != "pendente" && fase != "conectando") return

        espera = escopo.launch(Dispatchers.IO) {
            while (true) {
                val intervalo =
                    if (estado.optString("erro") == "sem_rede") INTERVALO_SEM_REDE else INTERVALO_ESPERA
                delay(intervalo)
                val agora = verificar(config)
                if (agora != "pendente" && agora != "conectando") break
            }
        }
    }

    // -------------------------------------------------------------- fachada

    fun configurar(config: Config) {
        urlDoSite = config.texto("siteUrl").ifEmpty { urlDoSite }
        api.configurar(config.texto("apiUrl"))
    }

    /** Chamada na subida do aplicativo. */
    fun iniciar(config: Config): JSONObject {
        configurar(config)
        if (!Credenciais.temToken(contexto)) {
            publicar(JSONObject().put("fase", "sem-token").put("erro", "").put("mensagem", ""))
            return atual()
        }
        verificar(config, apresentando = true)
        agendarEspera(config)
        return atual()
    }

    /** O usuario colou um token novo. */
    fun definirToken(texto: String, config: Config): JSONObject {
        val motivo = Credenciais.motivoDoTokenInvalido(texto)
        if (motivo.isNotEmpty()) return JSONObject().put("ok", false).put("mensagem", motivo)

        pararEspera()
        Credenciais.gravarToken(contexto, texto)
        ultimaConexao = 0 // token novo: a apresentacao vale de novo na hora
        verificar(config, apresentando = true)
        agendarEspera(config)
        return JSONObject().put("ok", true).put("estado", atual())
    }

    fun esquecerToken(): JSONObject {
        pararEspera()
        Credenciais.apagarToken(contexto)
        publicar(
            JSONObject().put("fase", "sem-token").put("erro", "").put("mensagem", "")
                .put("conta", JSONObject.NULL).put("gemas", JSONObject.NULL)
                .put("aplicativo", JSONObject.NULL)
        )
        return atual()
    }

    /** Botao "verificar agora" da tela de espera. */
    fun reverificar(config: Config): JSONObject {
        pararEspera()
        val apresentando =
            estado.optString("fase") == "sem-token" || estado.optString("erro") == "nao_conectado"
        verificar(config, apresentando)
        agendarEspera(config)
        return atual()
    }

    /**
     * Uma chamada qualquer do aplicativo tropecou numa recusa de autorizacao: o
     * estado tem de acompanhar, senao a tela continua dizendo "aprovado"
     * enquanto nada responde.
     */
    fun registrarFalha(erro: Throwable, config: Config) {
        val codigo = codigoDe(erro)
        if (codigo !in listOf(
                "token_invalido", "conta_inativa", "assinatura_inativa",
                "nao_conectado", "aguardando_aprovacao", "sem_vaga"
            )
        ) return
        tratarFalha(erro, config)
        agendarEspera(config)
    }

    /** Atualiza o saldo de gemas e os dados da conta, sem mexer na fase. */
    fun atualizarConta(config: Config): JSONObject {
        if (estado.optString("fase") != "aprovado") return atual()
        try {
            val dados = api.conta()
            publicar(
                JSONObject()
                    .put("conta", dados.opt("conta") ?: JSONObject.NULL)
                    .put("gemas", dados.opt("gemas") ?: JSONObject.NULL)
                    .put("aplicativo", dados.opt("aplicativo") ?: JSONObject.NULL)
                    .put("verificadoEm", Diagnostico.agora())
            )
        } catch (erro: Throwable) {
            registrarFalha(erro, config)
        }
        return atual()
    }

    fun encerrar() = pararEspera()
}
