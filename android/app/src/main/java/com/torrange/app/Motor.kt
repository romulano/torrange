package com.torrange.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.libtorrent4j.AddTorrentParams
import org.libtorrent4j.AlertListener
import org.libtorrent4j.ErrorCode
import org.libtorrent4j.Priority
import org.libtorrent4j.SessionHandle
import org.libtorrent4j.SessionManager
import org.libtorrent4j.SessionParams
import org.libtorrent4j.SettingsPack
import org.libtorrent4j.Sha1Hash
import org.libtorrent4j.TorrentFlags
import org.libtorrent4j.TorrentHandle
import org.libtorrent4j.TorrentInfo
import org.libtorrent4j.TorrentStatus
import org.libtorrent4j.Vectors
import org.libtorrent4j.alerts.Alert
import org.libtorrent4j.alerts.AlertType
import org.libtorrent4j.alerts.SaveResumeDataAlert
import org.libtorrent4j.alerts.TorrentAlert
import org.libtorrent4j.swig.error_code
import org.libtorrent4j.swig.libtorrent
import org.libtorrent4j.swig.settings_pack
import java.io.File

/**
 * O motor de torrent -- o lugar que no desktop era ocupado pelo qBittorrent.
 *
 * A troca e menos radical do que parece: o qBittorrent tambem e a libtorrent
 * por dentro. O que sai e o processo separado com a WebUI (porta, senha
 * sorteada, HTTP indo e voltando); o que entra e a mesma biblioteca chamada
 * direto, dentro do processo do aplicativo. Some com ela toda a parte de
 * "esperar o qBittorrent subir" -- mas nao com a TELA de espera, que continua
 * valendo: aqui a sessao tambem leva um instante para abrir as portas, e um
 * download pedido nesse intervalo tem de ficar guardado em vez de se perder.
 *
 * O formato do que este arquivo devolve e, de proposito, o mesmo do
 * /torrents/info do qBittorrent. A interface e a mesma do desktop e le esses
 * campos; manter o formato foi mais barato (e menos arriscado) do que mexer na
 * interface.
 */
class Motor(private val contexto: Context, private val config: Config) {

    companion object {
        /** O que o qBittorrent chama de "infinito" na coluna de tempo restante. */
        const val ETA_INFINITA = 8_640_000L
        private const val CATEGORIA = "torrange"
    }

    class Estado(val fase: String, val motivo: String = "")

    private var sessao: SessionManager? = null
    private val emFila = LinkedHashMap<String, TorrentHandle>()
    private val registro = ArrayDeque<String>()
    private var estado = Estado("iniciando")
    private var aoEstado: (Estado) -> Unit = {}
    private var ultimoErro: String = ""
    private var ultimaGravacaoDeRetomada = 0L

    val ativo: Boolean get() = sessao?.isRunning == true

    fun estado(): Estado = estado
    fun ultimoErro(): String = ultimoErro

    @Synchronized
    fun registro(): List<String> = registro.toList()

    private fun anotar(texto: String) {
        registro.addLast("${Diagnostico.agora()}  $texto")
        while (registro.size > 200) registro.removeFirst()
        Diagnostico.anotar("motor", texto)
    }

    private fun publicar(fase: String, motivo: String = "") {
        estado = Estado(fase, motivo)
        aoEstado(estado)
    }

    // -------------------------------------------------------------- sessao

    /**
     * Ajustes da sessao. Os numeros sao menores que os de um cliente de
     * desktop de proposito: no telefone o gargalo nao e a banda, e a bateria e
     * o calor -- e uma sessao com 500 conexoes abertas derruba roteador
     * domestico e esvazia a bateria em uma hora.
     */
    private fun ajustes(): SettingsPack {
        val cfg = config.ler()
        val pack = SettingsPack()

        pack.setString(settings_pack.string_types.user_agent.swigValue(), "Torrange/${BuildConfig.VERSION_NAME}")
        pack.setString(
            settings_pack.string_types.peer_fingerprint.swigValue(),
            "-TR1100-" // quem olha o enxame ve um cliente comum, nao um app novo
        )
        pack.setString(
            settings_pack.string_types.listen_interfaces.swigValue(),
            "0.0.0.0:6881,[::]:6881"
        )

        pack.setBoolean(settings_pack.bool_types.enable_dht.swigValue(), true)
        pack.setBoolean(settings_pack.bool_types.enable_lsd.swigValue(), true)
        pack.setBoolean(settings_pack.bool_types.enable_upnp.swigValue(), true)
        pack.setBoolean(settings_pack.bool_types.enable_natpmp.swigValue(), true)

        pack.setInteger(settings_pack.int_types.active_downloads.swigValue(), 4)
        pack.setInteger(settings_pack.int_types.active_seeds.swigValue(), 4)
        pack.setInteger(settings_pack.int_types.active_limit.swigValue(), 8)
        pack.setInteger(settings_pack.int_types.connections_limit.swigValue(), 120)
        pack.setInteger(settings_pack.int_types.active_checking.swigValue(), 1)

        // Os limites de Ajustes chegam em KiB/s, como no desktop; a libtorrent
        // quer bytes por segundo. 0 continua querendo dizer "sem limite".
        pack.setInteger(
            settings_pack.int_types.download_rate_limit.swigValue(),
            cfg.optInt("limiteDownload", 0) * 1024
        )
        pack.setInteger(
            settings_pack.int_types.upload_rate_limit.swigValue(),
            cfg.optInt("limiteUpload", 0) * 1024
        )

        // Um cache pequeno: a memoria do aplicativo e disputada com a WebView
        // e com o decodificador de video.
        pack.setInteger(settings_pack.int_types.max_queued_disk_bytes.swigValue(), 4 * 1024 * 1024)

        return pack
    }

    @Synchronized
    fun iniciar(aoEstado: (Estado) -> Unit) {
        this.aoEstado = aoEstado
        if (sessao?.isRunning == true) {
            publicar("pronto")
            return
        }

        publicar("iniciando")
        try {
            val s = SessionManager()
            s.addListener(ouvinte)
            s.start(SessionParams(ajustes()))
            sessao = s
            anotar("sessao no ar, porta ${try { SessionHandle(s.swig()).listenPort } catch (e: Exception) { "?" }}")
            restaurar()
            publicar("pronto")
        } catch (e: Throwable) {
            ultimoErro = e.message ?: e.toString()
            anotar("falhei ao subir a sessao: $ultimoErro")
            Diagnostico.anotarErro("motor", e)
            publicar("erro", ultimoErro)
        }
    }

    private val ouvinte = object : AlertListener {
        override fun types(): IntArray? = null // todos

        override fun alert(alerta: Alert<*>) {
            try {
                when (alerta.type()) {
                    AlertType.ADD_TORRENT -> {
                        val h = (alerta as TorrentAlert<*>).handle()
                        if (h.isValid) lembrar(h)
                    }
                    AlertType.METADATA_RECEIVED -> {
                        // O magnet acabou de virar um torrent de verdade: agora
                        // ha pecas para priorizar, e a fila ja pode ser gravada
                        // com o nome certo.
                        val h = (alerta as TorrentAlert<*>).handle()
                        aplicarSequencial(h)
                        h.saveResumeData()
                        guardarFila()
                    }
                    AlertType.SAVE_RESUME_DATA -> {
                        val a = alerta as SaveResumeDataAlert
                        val hash = a.handle().infoHash().toHex()
                        val bytes = AddTorrentParams.writeResumeDataBuf(a.params())
                        File(Caminhos.retomada(contexto), "$hash.dat").writeBytes(bytes)
                    }
                    AlertType.TORRENT_FINISHED -> {
                        val h = (alerta as TorrentAlert<*>).handle()
                        anotar("concluido: ${h.status().name()}")
                        h.saveResumeData()
                    }
                    AlertType.LISTEN_FAILED, AlertType.SESSION_ERROR -> {
                        anotar(alerta.message())
                    }
                    AlertType.TORRENT_ERROR, AlertType.FILE_ERROR -> {
                        ultimoErro = alerta.message()
                        anotar(alerta.message())
                    }
                    else -> {}
                }
            } catch (e: Throwable) {
                Diagnostico.anotarErro("motor", e)
            }
        }
    }

    @Synchronized
    private fun lembrar(h: TorrentHandle) {
        val hash = h.infoHash().toHex()
        emFila[hash] = h
        guardarFila()
    }

    // ------------------------------------------------------- o que fica gravado

    /**
     * A fila e reconstruida na proxima abertura a partir daqui. Guardamos o
     * .torrent (ou o magnet, enquanto ele nao virou arquivo) e a pasta de
     * destino -- o resto a libtorrent redescobre.
     */
    @Synchronized
    private fun guardarFila() {
        try {
            val lista = JSONArray()
            for ((hash, h) in emFila) {
                if (!h.isValid) continue
                lista.put(
                    JSONObject()
                        .put("hash", hash)
                        .put("nome", h.status().name())
                        .put("savePath", h.savePath())
                        .put("magnet", try { h.makeMagnetUri() } catch (e: Exception) { "" })
                )
            }
            Caminhos.fila(contexto).writeText(lista.toString())
        } catch (e: Exception) {
            Diagnostico.anotar("erro", "nao consegui gravar a fila: ${e.message}")
        }
    }

    private fun arquivoTorrentDe(hash: String) = File(Caminhos.torrents(contexto), "$hash.torrent")

    /** Reabre o que ja estava na fila quando o aplicativo foi fechado. */
    private fun restaurar() {
        val arquivo = Caminhos.fila(contexto)
        if (!arquivo.exists()) return

        val lista = try {
            JSONArray(arquivo.readText())
        } catch (e: Exception) {
            return
        }

        for (i in 0 until lista.length()) {
            val item = lista.optJSONObject(i) ?: continue
            val hash = item.optString("hash")
            val pasta = File(item.optString("savePath").ifEmpty { config.texto("pastaDownloads") })
            try {
                val retomada = File(Caminhos.retomada(contexto), "$hash.dat")
                val torrent = arquivoTorrentDe(hash)

                val params: AddTorrentParams = when {
                    // O melhor caso: a libtorrent volta sabendo o que ja tem em
                    // disco e nao reconfere 20 GB a cada abertura.
                    retomada.exists() -> {
                        val ec = error_code()
                        val swig = libtorrent.read_resume_data_ex(
                            Vectors.bytes2byte_vector(retomada.readBytes()), ec
                        )
                        if (ec.value() != 0) throw Exception("retomada inválida: ${ec.message()}")
                        AddTorrentParams(swig)
                    }
                    torrent.exists() -> AddTorrentParams().apply {
                        setTorrentInfo(TorrentInfo.bdecode(torrent.readBytes()))
                    }
                    item.optString("magnet").isNotEmpty() ->
                        AddTorrentParams.parseMagnetUri(item.optString("magnet"))
                    else -> continue
                }

                if (params.savePath.isNullOrEmpty()) params.savePath = pasta.absolutePath
                adicionarParams(params)
            } catch (e: Exception) {
                anotar("nao consegui reabrir $hash: ${e.message}")
            }
        }
        anotar("fila reaberta com ${emFila.size} torrent(s)")
    }

    // ------------------------------------------------------------- adicionar

    private fun sessaoViva(): SessionManager =
        sessao?.takeIf { it.isRunning } ?: throw Exception("O motor de torrent ainda não subiu.")

    private fun adicionarParams(params: AddTorrentParams): TorrentHandle? {
        val s = sessaoViva()
        Caminhos.garantir(File(params.savePath))

        if (config.ligado("downloadSequencial")) {
            params.flags = params.flags.or_(TorrentFlags.SEQUENTIAL_DOWNLOAD)
        }

        val erro = ErrorCode(error_code())
        val h = SessionHandle(s.swig()).addTorrent(params, erro)
        if (erro.isError) throw Exception(erro.message)
        if (h == null || !h.isValid) throw Exception("a libtorrent recusou o torrent")

        lembrar(h)
        aplicarSequencial(h)
        return h
    }

    /**
     * Sequencial mais prioridade nas primeiras e ultimas pecas: e o que permite
     * dar play antes de o download terminar. O fim entra junto porque o
     * indice do MKV costuma morar la, e sem ele o player nao sabe procurar.
     */
    private fun aplicarSequencial(h: TorrentHandle) {
        if (!config.ligado("downloadSequencial")) return
        try {
            h.setFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD)
            val ti = h.torrentFile() ?: return
            val total = ti.numPieces()
            if (total <= 0) return
            val quantas = minOf(8, total / 2)
            for (i in 0 until quantas) {
                h.piecePriority(i, Priority.TOP_PRIORITY)
                h.piecePriority(total - 1 - i, Priority.TOP_PRIORITY)
            }
        } catch (e: Exception) {
            Diagnostico.anotar("motor", "nao consegui priorizar as pecas: ${e.message}")
        }
    }

    /**
     * Entra um torrent -- por arquivo (o caso do acervo) ou por magnet.
     * Devolve o item no formato do /torrents/info, como o desktop fazia.
     */
    @Synchronized
    fun adicionar(dados: ByteArray?, nome: String?, magnet: String?): JSONObject? {
        val pasta = config.pastaDownloads()

        val params = if (!magnet.isNullOrEmpty()) {
            AddTorrentParams.parseMagnetUri(magnet)
        } else {
            val bytes = dados ?: throw Exception("torrent vazio")
            val ti = try {
                TorrentInfo.bdecode(bytes)
            } catch (e: Exception) {
                throw Exception("O arquivo não é um .torrent válido.")
            }
            AddTorrentParams().apply { setTorrentInfo(ti) }
        }
        params.savePath = pasta.absolutePath

        // Ja esta na fila? Entao nao e erro: e o mesmo titulo pedido de novo.
        val hashes = params.infoHashes
        val existente = hashes?.v1?.let { encontrar(it.toHex()) }
        if (existente != null) {
            anotar("já estava na fila: ${existente.status().name()}")
            return comoInfo(existente)
        }

        val h = adicionarParams(params) ?: return null

        if (dados != null) {
            try {
                arquivoTorrentDe(h.infoHash().toHex()).writeBytes(dados)
            } catch (e: Exception) {
                Diagnostico.anotar("erro", "nao consegui guardar o .torrent: ${e.message}")
            }
        }
        anotar("na fila: ${h.status().name()}")
        return comoInfo(h)
    }

    // --------------------------------------------------------------- comandos

    @Synchronized
    fun encontrar(hash: String): TorrentHandle? {
        emFila[hash]?.let { if (it.isValid) return it }
        return try {
            sessao?.find(Sha1Hash.parseHex(hash))?.takeIf { it.isValid }
        } catch (e: Exception) {
            null
        }
    }

    @Synchronized
    fun pausar(hash: String) {
        encontrar(hash)?.let {
            it.pause()
            it.saveResumeData()
        }
    }

    @Synchronized
    fun retomar(hash: String) {
        encontrar(hash)?.resume()
    }

    @Synchronized
    fun remover(hash: String, apagarArquivos: Boolean) {
        val h = encontrar(hash) ?: return
        val s = sessao
        try {
            if (apagarArquivos) {
                s?.remove(h, org.libtorrent4j.swig.session_handle.delete_files)
            } else {
                s?.remove(h)
            }
        } catch (e: Exception) {
            Diagnostico.anotarErro("motor", e)
        }
        emFila.remove(hash)
        try {
            arquivoTorrentDe(hash).delete()
            File(Caminhos.retomada(contexto), "$hash.dat").delete()
        } catch (e: Exception) {
            // nada a fazer
        }
        guardarFila()
    }

    fun aplicarPreferencias() {
        try {
            sessao?.applySettings(ajustes())
        } catch (e: Exception) {
            Diagnostico.anotarErro("motor", e)
        }
    }

    /** Suspende a sessao sem derrubar nada -- usado quando o aplicativo sai da frente. */
    fun suspender() {
        try {
            sessao?.pause()
            anotar("sessao suspensa (aplicativo em segundo plano)")
        } catch (e: Exception) {
            // nada a fazer
        }
    }

    fun continuar() {
        try {
            sessao?.resume()
        } catch (e: Exception) {
            // nada a fazer
        }
    }

    @Synchronized
    fun encerrar() {
        try {
            for (h in emFila.values) if (h.isValid) h.saveResumeData()
            Thread.sleep(300) // deixa os alertas de retomada chegarem
            guardarFila()
            sessao?.stop()
            anotar("sessao encerrada")
        } catch (e: Exception) {
            Diagnostico.anotarErro("motor", e)
        }
        sessao = null
    }

    // ---------------------------------------------------------------- leitura

    /**
     * O nome de estado que a interface entende. Sao os do qBittorrent, porque
     * e a mesma interface do desktop lendo -- traduzir aqui sai mais barato do
     * que ensinar dois vocabularios a ela.
     */
    private fun nomeDoEstado(st: TorrentStatus, pausado: Boolean): String {
        val terminou = st.isFinished
        if (pausado) return if (terminou) "pausedUP" else "pausedDL"
        return when (st.state()) {
            TorrentStatus.State.CHECKING_FILES, TorrentStatus.State.CHECKING_RESUME_DATA ->
                if (terminou) "checkingUP" else "checkingDL"
            TorrentStatus.State.DOWNLOADING_METADATA -> "metaDL"
            TorrentStatus.State.DOWNLOADING ->
                if (st.downloadPayloadRate() > 0) "downloading" else "stalledDL"
            TorrentStatus.State.FINISHED, TorrentStatus.State.SEEDING ->
                if (st.uploadPayloadRate() > 0) "uploading" else "stalledUP"
            else -> "stalledDL"
        }
    }

    private fun comoInfo(h: TorrentHandle): JSONObject? {
        if (!h.isValid) return null
        val st = h.status()
        val pausado = st.flags().and_(TorrentFlags.PAUSED).non_zero()
        val falta = (st.totalWanted() - st.totalWantedDone()).coerceAtLeast(0)
        val taxa = st.downloadPayloadRate()

        val nome = st.name().ifEmpty { h.infoHash().toHex() }
        val pasta = h.savePath()
        val ti = try { h.torrentFile() } catch (e: Exception) { null }
        val caminhoConteudo = when {
            ti == null -> pasta
            ti.numFiles() == 1 -> File(pasta, ti.files().filePath(0)).absolutePath
            else -> File(pasta, nome).absolutePath
        }

        return JSONObject()
            .put("hash", h.infoHash().toHex())
            .put("name", nome)
            .put("progress", st.progress().toDouble())
            .put("state", nomeDoEstado(st, pausado))
            .put("dlspeed", taxa)
            .put("upspeed", st.uploadPayloadRate())
            .put("eta", if (taxa > 0) falta / taxa else ETA_INFINITA)
            .put("size", st.totalWanted())
            .put("total_size", st.total())
            .put("downloaded", st.totalDone())
            .put("uploaded", st.allTimeUpload())
            .put("num_seeds", st.numSeeds())
            .put("num_leechs", (st.numPeers() - st.numSeeds()).coerceAtLeast(0))
            .put("save_path", pasta)
            .put("content_path", caminhoConteudo)
            .put("added_on", st.addedTime())
            .put("completion_on", st.completedTime())
            .put("category", CATEGORIA)
    }

    /** A fila inteira, no formato do /torrents/info. */
    @Synchronized
    fun listar(): List<JSONObject> {
        val s = sessao ?: return emptyList()
        val saida = mutableListOf<JSONObject>()
        val vistos = HashSet<String>()

        // A sessao e a fonte da verdade; o mapa serve de indice e de ordem.
        val daSessao = try {
            SessionHandle(s.swig()).torrents()
        } catch (e: Exception) {
            emptyList<TorrentHandle>()
        }
        for (h in daSessao) {
            if (!h.isValid) continue
            val hash = h.infoHash().toHex()
            if (!vistos.add(hash)) continue
            emFila[hash] = h
            comoInfo(h)?.let { saida.add(it) }
        }

        gravarRetomadaDeVezEmQuando()
        return saida
    }

    /**
     * De tempos em tempos pedimos a retomada de tudo. E o que faz a proxima
     * abertura comecar de onde parou em vez de reconferir os arquivos inteiros.
     */
    private fun gravarRetomadaDeVezEmQuando() {
        val agora = System.currentTimeMillis()
        if (agora - ultimaGravacaoDeRetomada < 60_000) return
        ultimaGravacaoDeRetomada = agora
        for (h in emFila.values) {
            try {
                if (h.isValid && h.status().hasMetadata()) h.saveResumeData()
            } catch (e: Exception) {
                // nada a fazer
            }
        }
        guardarFila()
    }

    /** Os arquivos de um torrent, no formato do /torrents/files. */
    @Synchronized
    fun arquivosDe(hash: String): List<JSONObject> {
        val h = encontrar(hash) ?: return emptyList()
        val ti = h.torrentFile() ?: return emptyList()
        val arquivos = ti.files()
        val progresso = try {
            h.fileProgress()
        } catch (e: Exception) {
            LongArray(arquivos.numFiles())
        }

        val saida = mutableListOf<JSONObject>()
        for (i in 0 until arquivos.numFiles()) {
            val tamanho = arquivos.fileSize(i)
            val feito = if (i < progresso.size) progresso[i] else 0L
            saida.add(
                JSONObject()
                    .put("index", i)
                    .put("name", arquivos.filePath(i))
                    .put("size", tamanho)
                    .put("progress", if (tamanho > 0) feito.toDouble() / tamanho else 0.0)
            )
        }
        return saida
    }

    /** Para o arquivo de diagnostico. */
    fun diagnostico(): JSONObject {
        val s = sessao
        return JSONObject()
            .put("fase", estado.fase)
            .put("motivo", estado.motivo)
            .put("ativo", s?.isRunning == true)
            .put("porta", try { SessionHandle(s!!.swig()).listenPort } catch (e: Exception) { JSONObject.NULL })
            .put("dht", try { s?.isDhtRunning == true } catch (e: Exception) { false })
            .put("nosDht", try { s?.dhtNodes() ?: -1 } catch (e: Exception) { -1 })
            .put("taxaDownload", try { s?.downloadRate() ?: 0 } catch (e: Exception) { 0 })
            .put("taxaUpload", try { s?.uploadRate() ?: 0 } catch (e: Exception) { 0 })
            .put("naFila", emFila.size)
            .put("ultimoErro", ultimoErro.ifEmpty { JSONObject.NULL })
    }
}
