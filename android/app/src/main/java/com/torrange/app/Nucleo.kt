package com.torrange.app

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * O nucleo: junta as pecas e e o unico lugar que a interface conversa.
 *
 * No desktop este papel era do `src/main/index.js`. As quatro pecas continuam
 * as mesmas -- a API do site (token + acervo), o motor de torrent, a
 * biblioteca e o player --, e as regras que as amarram tambem:
 *
 *  - o GET /baixar nunca debita; so o POST cobra, e ele nao e repetido sozinho;
 *  - um download pedido antes de o motor subir fica GUARDADO e entra na fila
 *    quando ele responder -- perder o torrent seria o mesmo que o toque nao
 *    ter funcionado;
 *  - o .torrent nunca passa pela pasta de downloads do usuario: vai da API
 *    para a memoria e da memoria para o motor.
 */
class Nucleo(private val contexto: Context) {

    val config = Config(contexto)
    val api = Api(contexto)
    val metadados = Metadados(contexto)
    val motor = Motor(contexto, config)
    val biblioteca = Biblioteca(contexto, motor)
    val player = Player(contexto)

    private val trabalho = SupervisorJob()
    val escopo = CoroutineScope(Dispatchers.IO + trabalho)

    val conexao = Conexao(contexto, api, escopo) { estado -> emitir("conexao:estado", estado) }

    /** Para onde os eventos vao (a WebView, quando ela existe). */
    @Volatile
    var ouvinte: ((String, Any) -> Unit)? = null

    private var monitor: Job? = null
    private var iniciado = false

    /**
     * O que o usuario pediu antes de o motor subir. Guardar aqui e o que faz
     * um toque em "Baixar" nos primeiros segundos nao se perder.
     */
    private class Pedido(val dados: ByteArray?, val nome: String?, val magnet: String?)

    private val pendentes = mutableListOf<Pedido>()
    private var estadoMotor = JSONObject().put("fase", "iniciando").put("motivo", "").put("tentativa", 0)
    private val progressoAnterior = HashMap<String, Double>()
    private var tentativas = 0

    // Player: o que esta aberto agora, para alimentar a barra de buffer e
    // salvar a posicao.
    @Volatile var hashNoPlayer: String = ""
    @Volatile var caminhoNoPlayer: String = ""

    // ----------------------------------------------------------------- eventos

    fun emitir(canal: String, dados: Any) {
        ouvinte?.invoke(canal, dados)
    }

    fun avisar(texto: String, tipo: String = "info") {
        emitir("aviso", JSONObject().put("texto", texto).put("tipo", tipo))
        Diagnostico.anotar("aviso", "[$tipo] $texto")
    }

    // ------------------------------------------------------------------ subida

    @Synchronized
    fun iniciar() {
        if (iniciado) return
        iniciado = true

        Diagnostico.anotar("nucleo", "subindo o Torrange ${BuildConfig.VERSION_NAME}")
        conexao.configurar(config)

        escopo.launch {
            conexao.iniciar(config)
        }
        escopo.launch {
            subirMotor()
        }
        iniciarMonitor()
    }

    private fun subirMotor() {
        publicarEstadoMotor("iniciando")
        // Erro de disco ou de tracker vai para a tela, e nao so para o
        // registro: "nao baixa e nao diz por que" e o pior desfecho.
        motor.aoAviso = { texto, tipo -> avisar(texto, tipo) }
        motor.iniciar { estado ->
            publicarEstadoMotor(estado.fase, estado.motivo)
            if (estado.fase == "pronto") {
                escopo.launch { despejarPendentes() }
            }
        }
    }

    fun tentarMotorDeNovo(): JSONObject {
        tentativas++
        subirMotor()
        return estadoMotor
    }

    @Synchronized
    private fun publicarEstadoMotor(fase: String, motivo: String = "") {
        estadoMotor = JSONObject()
            .put("fase", fase)
            .put("motivo", motivo)
            .put("tentativa", tentativas)
            .put("pendentes", pendentes.size)
        emitir("qbit:estado", estadoMotor)
    }

    fun estadoMotor(): JSONObject = estadoMotor

    // -------------------------------------------------------- entrada de torrents

    /** Guarda o pedido para quando o motor responder. */
    @Synchronized
    private fun enfileirar(pedido: Pedido, titulo: String) {
        pendentes.add(pedido)
        publicarEstadoMotor(estadoMotor.optString("fase"), estadoMotor.optString("motivo"))
        if (estadoMotor.optString("fase") == "erro") {
            avisar(
                "O motor de torrent não subiu, então \"$titulo\" está esperando. " +
                    "Veja o motivo na aba Downloads.",
                "erro"
            )
            return
        }
        avisar("O motor de torrent ainda está subindo. \"$titulo\" entra na fila assim que ele responder.", "info")
    }

    /** Manda para a fila tudo o que ficou esperando. */
    private fun despejarPendentes() {
        val lista: List<Pedido>
        synchronized(this) {
            if (pendentes.isEmpty()) return
            lista = pendentes.toList()
            pendentes.clear()
        }
        publicarEstadoMotor(estadoMotor.optString("fase"), estadoMotor.optString("motivo"))
        for (p in lista) receberTorrent(p.dados, p.nome, p.magnet)
    }

    fun receberTorrent(dados: ByteArray?, nome: String?, magnet: String? = null): JSONObject {
        if (!motor.ativo) {
            val titulo = if (magnet != null) "o link magnet"
            else (nome ?: "torrent").removeSuffix(".torrent")
            enfileirar(Pedido(dados, nome, magnet), titulo)
            return JSONObject().put("esperando", true)
        }
        return try {
            val t = motor.adicionar(dados, nome, magnet)
            val titulo = t?.optString("name")?.ifEmpty { null }
                ?: (nome ?: "").removeSuffix(".torrent")
            avisar("Baixando: $titulo", "ok")
            Notificacoes.mostrar(contexto, "Download iniciado", titulo)
            atualizar()
            JSONObject().put("ok", true).put("titulo", titulo)
        } catch (e: Exception) {
            avisar(e.message ?: "não consegui adicionar o torrent", "erro")
            JSONObject().put("erro", e.message ?: "falha")
        }
    }

    fun receberMagnet(magnet: String): JSONObject = receberTorrent(null, null, magnet)

    /**
     * Entrada por endereco web: aceita o link direto do .torrent e tambem o
     * endereco de uma pagina que tenha o link dentro dela.
     */
    fun receberUrl(endereco: String): JSONObject {
        val texto = endereco.trim()
        if (texto.startsWith("magnet:")) return receberMagnet(texto)
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(texto)) {
            avisar("Cole um link magnet ou um endereço que comece com http:// ou https://", "erro")
            return JSONObject().put("erro", "endereço inválido")
        }
        return try {
            val arquivo = Endereco.pegar(texto, seguirPagina = true)
            if (arquivo == null) {
                avisar("Esse endereço não devolveu um arquivo .torrent.", "erro")
                JSONObject().put("erro", "sem torrent")
            } else {
                receberTorrent(arquivo.dados, arquivo.nome)
            }
        } catch (e: Exception) {
            avisar("Não consegui baixar o torrent: ${e.message}", "erro")
            JSONObject().put("erro", e.message ?: "falha")
        }
    }

    /** Entrada por arquivo: o usuario escolheu um ou mais .torrent. */
    fun receberArquivos(uris: List<android.net.Uri>): JSONObject {
        var adicionados = 0
        for (uri in uris) {
            try {
                val dados = contexto.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                val nome = nomeDoUri(uri)
                if (dados == null || !Endereco.ehBytesTorrent(dados)) {
                    avisar("$nome não parece um arquivo .torrent.", "erro")
                    continue
                }
                receberTorrent(dados, nome)
                adicionados++
            } catch (e: Exception) {
                avisar("Falha ao ler o arquivo: ${e.message}", "erro")
            }
        }
        return JSONObject().put("adicionados", adicionados)
    }

    private fun nomeDoUri(uri: android.net.Uri): String {
        try {
            contexto.contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) return c.getString(i)
            }
        } catch (e: Exception) {
            // cai no nome do caminho
        }
        return uri.lastPathSegment ?: "arquivo.torrent"
    }

    // ------------------------------------------------------------------ acervo

    /**
     * Envelopa uma chamada da API: a interface recebe sempre { ok } ou
     * { erro, mensagem }, e a maquina de estados da conexao fica sabendo quando
     * a recusa foi de autorizacao (token trocado, aparelho removido, assinatura).
     */
    fun chamarApi(fn: () -> Any?): JSONObject = try {
        JSONObject().put("ok", true).put("dados", fn())
    } catch (erro: Throwable) {
        conexao.registrarFalha(erro, config)
        JSONObject()
            .put("ok", false)
            .put("erro", (erro as? ErroApi)?.erro ?: (erro as? ErroRede)?.erro ?: "falha")
            .put("mensagem", erro.message ?: "Não consegui falar com o site.")
            .put("retryAfter", (erro as? ErroApi)?.retryAfter ?: 0)
            // O corpo da recusa vai junto: e nele que vem o preco novo do
            // preco_mudou e o saldo do sem_saldo, que a tela precisa mostrar.
            .put("dados", (erro as? ErroApi)?.dados ?: JSONObject.NULL)
    }

    // As capas vem dezenas por tela; guardamos as ultimas para nao bater na API
    // a cada rolagem (o teto da rota e de 300 por minuto). Um item que a API
    // nao tem entra como null e fica no cache do mesmo jeito -- senao cada
    // rolagem pediria de novo o que ja sabemos nao existir.
    private val capas = LinkedHashMap<String, Pair<ByteArray, String>?>()
    private val MAX_CAPAS = 240

    fun capaDoAcervo(item: String): Pair<ByteArray, String>? {
        synchronized(capas) { if (capas.containsKey(item)) return capas[item] }
        val resultado = try {
            api.capa(item)
        } catch (e: Exception) {
            null // capa que falha e um quadrado vazio, nao um erro na tela
        }
        synchronized(capas) {
            if (capas.size >= MAX_CAPAS) capas.remove(capas.keys.first())
            capas[item] = resultado
        }
        return resultado
    }

    fun limparCapas() {
        synchronized(capas) { capas.clear() }
    }

    /**
     * Baixar uma opcao do acervo.
     *
     * O GET nunca debita: se a opcao for free o arquivo vem na hora. Se custar
     * gema, a API responde 402 com preco e saldo e NADA acontece -- a
     * confirmacao volta para a tela, e so o POST cobra.
     */
    fun baixarDoAcervo(item: String): JSONObject {
        val r = chamarApi { api.baixar(item) }
        if (!r.optBoolean("ok")) return r

        val entrega = r.opt("dados") as? Api.Entrega ?: return r
        entrega.confirmacao?.let { c ->
            return JSONObject().put("ok", true).put(
                "confirmacao",
                JSONObject()
                    .put("item", c.item)
                    .put("preco", c.preco)
                    .put("saldo", c.saldo)
                    .put("mensagem", c.mensagem)
            )
        }

        val t = entrega.torrent!!
        val entrada = receberTorrent(t.dados, t.nome)
        return entrada.put("ok", true).put("baixando", true)
    }

    /**
     * Confirma um download pago. Sem retry, de proposito: o servidor entrega e
     * cobra cada chamada por si, entao repetir depois de um timeout debitaria
     * duas vezes. Se a resposta nao chegar, o saldo e conferido em /conta.
     */
    fun confirmarDownload(item: String, preco: Double): JSONObject {
        val r = chamarApi { api.confirmarBaixar(item, preco) }
        if (!r.optBoolean("ok")) {
            // "o preco virou entre a confirmacao e o POST": nada foi debitado e
            // a resposta ja traz o valor de agora, entao a tela repergunta.
            return r
        }
        val entrega = r.opt("dados") as? Api.Entrega ?: return r
        val t = entrega.torrent ?: return r
        val entrada = receberTorrent(t.dados, t.nome)
        conexao.atualizarConta(config) // o saldo mudou
        return entrada.put("ok", true).put("baixando", true)
    }

    // ----------------------------------------------------------------- monitor

    fun atualizar() {
        try {
            val bibliotecaAtual = metadados.aplicar(biblioteca.sincronizar())
            val fila = biblioteca.snapshot()

            // avisa quando um download termina
            for (i in 0 until fila.length()) {
                val t = fila.optJSONObject(i) ?: continue
                val hash = t.optString("hash")
                val agora = t.optDouble("progress", 0.0)
                val antes = progressoAnterior[hash]
                if (antes != null && antes < 1.0 && agora >= 1.0) {
                    Notificacoes.mostrar(contexto, "Download concluído", t.optString("name"))
                    avisar("Pronto para assistir: ${t.optString("name")}", "ok")
                }
                progressoAnterior[hash] = agora
            }

            alimentarBarraDeBuffer(bibliotecaAtual)

            emitir("fila:atualizou", fila)
            emitir("biblioteca:atualizou", bibliotecaAtual)
        } catch (e: Exception) {
            Diagnostico.anotar("monitor", e.message ?: e.toString())
        }
    }

    /**
     * Diz ao player ate onde o arquivo ja foi baixado. E o que desenha, na
     * barra do player, o trecho que da para assistir agora.
     */
    private fun alimentarBarraDeBuffer(biblioteca: JSONArray) {
        if (hashNoPlayer.isEmpty() || !player.aberto) return
        for (i in 0 until biblioteca.length()) {
            val e = biblioteca.optJSONObject(i) ?: continue
            if (e.optString("hash") != hashNoPlayer) continue
            val arquivos = e.optJSONArray("arquivos") ?: return
            for (j in 0 until arquivos.length()) {
                val a = arquivos.optJSONObject(j) ?: continue
                if (a.optString("caminho") == caminhoNoPlayer) {
                    player.informarProgressoDoArquivo(a.optDouble("progresso", 0.0))
                    return
                }
            }
        }
    }

    private fun iniciarMonitor() {
        monitor?.cancel()
        monitor = escopo.launch {
            while (true) {
                delay(1000)
                if (motor.ativo) atualizar()
            }
        }
    }

    // -------------------------------------------------------------------- info

    fun info(): JSONObject = JSONObject()
        .put("versao", BuildConfig.VERSION_NAME)
        .put("electron", "—") // nao ha Electron aqui; a interface so mostra o campo
        .put("plataforma", "android")
        .put("empacotado", true)
        .put("qbit", if (motor.ativo) "libtorrent embutida" else "parado")
        // Nao ha WebUI para abrir no navegador: o motor roda dentro do processo.
        .put("webui", JSONObject.NULL)
        .put("qbitUsuario", "")
        .put("qbitCredencialTemporaria", false)
        .put("dados", contexto.filesDir.absolutePath)
        .put("api", api.base())
        // o token nunca sai daqui: so a forma mascarada e o id da instalacao
        .put("conexao", Credenciais.resumo(contexto))
        .put("binarios", JSONObject().put("qbit", "libtorrent4j").put("mpv", "libVLC"))
        .put("videoAcoplado", true)
        .put("android", android.os.Build.VERSION.RELEASE)
        .put("aparelho", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")

    /** Junta o que o modulo de diagnostico precisa das outras pecas. */
    fun fontesDeDiagnostico(tela: JSONObject?): JSONObject = JSONObject()
        .put("config", config.ler())
        .put("conexao", conexao.atual())
        .put("motor", motor.diagnostico())
        .put("registroMotor", JSONArray(motor.registro()))
        .put("player", try { player.diagnostico() } catch (e: Exception) { JSONObject().put("erro", e.message) })
        .put("fila", biblioteca.snapshot())
        .put("biblioteca", metadados.aplicar(biblioteca.listar()))
        .put("tela", tela ?: JSONObject.NULL)
        .put("webview", webviewInstalada())

    private fun webviewInstalada(): String = try {
        val pacote = android.webkit.WebView.getCurrentWebViewPackage()
        if (pacote != null) "${pacote.packageName} ${pacote.versionName}" else "(desconhecida)"
    } catch (e: Exception) {
        "(desconhecida)"
    }

    fun gerarDiagnostico(tela: JSONObject?): JSONObject = try {
        val destino = File(Caminhos.diagnosticos(contexto), Diagnostico.nomeSugerido())
        val r = Diagnostico.salvar(contexto, destino, fontesDeDiagnostico(tela))
        avisar("Diagnóstico salvo em ${destino.absolutePath}", "ok")
        r
    } catch (e: Exception) {
        Diagnostico.anotarErro("diagnostico", e)
        JSONObject().put("erro", e.message ?: "falha")
    }

    // ------------------------------------------------------------ ciclo de vida

    fun encerrar() {
        conexao.encerrar()
        monitor?.cancel()
        player.encerrar()
        motor.encerrar()
        trabalho.cancel()
        iniciado = false
    }
}
