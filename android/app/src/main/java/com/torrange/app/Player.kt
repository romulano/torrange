package com.torrange.app

import android.content.Context
import android.net.Uri
import android.view.SurfaceView
import org.json.JSONArray
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.MediaPlayer
import java.io.File

/**
 * Player: no desktop era o mpv acoplado a uma janela filha posicionada sobre a
 * area de video da interface. Aqui e a libVLC desenhando numa SurfaceView
 * posicionada exatamente no mesmo lugar -- a interface manda o retangulo pelo
 * mesmo canal (`ui:layout`) que mandava para o mpv.
 *
 * A libVLC resolve o que a WebView nao resolve: MKV, H.265, AC3/DTS/TrueHD,
 * multiplas faixas de audio e legendas embutidas (inclusive PGS e ASS), alem
 * de legendas externas na mesma pasta.
 *
 * Os comandos chegam no vocabulario do mpv (`cycle pause`, `seek`,
 * `set_property aid`), e as mudancas saem como as propriedades que o mpv
 * publicava (`time-pos`, `duration`, `pause`...). E de proposito: a interface e
 * a mesma do desktop, e traduzir aqui foi mais barato do que reescrever la.
 */
class Player(private val contexto: Context) {

    private var vlc: LibVLC? = null
    private var mp: MediaPlayer? = null
    private var superficie: SurfaceView? = null
    private var caminhoAtual: String = ""
    private var aoEvento: (JSONObject) -> Unit = {}

    /** O registro que o painel de diagnostico de Ajustes mostra. */
    private val registro = ArrayDeque<String>()

    // Ultimo estado conhecido, para responder get_property sem perguntar.
    private var duracao = 0.0
    private var tempo = 0.0
    private var pausado = false
    private var mudo = false
    private var volume = 100

    /**
     * Quanto do arquivo ja esta em disco (0 a 1), alimentado pelo monitor.
     *
     * O mpv publicava `demuxer-cache-time` e a interface desenhava com isso a
     * barra de buffer. Aqui o que limita nao e o demuxer, e o download: a
     * barra passa a mostrar ate onde da para assistir, que e a informacao que
     * o usuario de fato quer ver.
     */
    private var progressoDoArquivo = 0.0

    val aberto: Boolean get() = mp != null

    private fun anotar(texto: String) {
        registro.addLast("${Diagnostico.agora()}  $texto")
        while (registro.size > 80) registro.removeFirst()
        Diagnostico.anotar("player", texto)
    }

    fun configurar(superficie: SurfaceView, aoEvento: (JSONObject) -> Unit) {
        this.superficie = superficie
        this.aoEvento = aoEvento
    }

    private fun propriedade(nome: String, valor: Any?) {
        aoEvento(JSONObject().put("tipo", "propriedade").put("nome", nome).put("valor", valor))
    }

    private fun evento(nome: String) {
        aoEvento(JSONObject().put("tipo", "evento").put("nome", nome))
    }

    // ----------------------------------------------------------------- subir

    private fun motor(): LibVLC {
        vlc?.let { return it }
        val opcoes = arrayListOf(
            "--no-drop-late-frames",
            "--no-skip-frames",
            // O arquivo cresce enquanto e lido: sem isto a libVLC decide o
            // tamanho na abertura e para no que existia naquele instante.
            "--file-caching=3000",
            "--network-caching=3000",
            // Legendas externas na mesma pasta entram sozinhas, como no mpv.
            "--sub-autodetect-file",
            "--audio-time-stretch",
            "-v"
        )
        val novo = LibVLC(contexto, opcoes)
        vlc = novo
        anotar("libVLC no ar")
        return novo
    }

    /**
     * Abre um arquivo. `posicao` vem em segundos, como no desktop, e e onde o
     * usuario parou da ultima vez.
     */
    @Synchronized
    fun abrir(caminho: String, posicao: Double, volumeInicial: Int): JSONObject {
        val arquivo = File(caminho)
        if (!arquivo.exists()) throw Exception("O arquivo ainda não está no disco.")

        fecharInterno()

        val jogador = MediaPlayer(motor())
        mp = jogador
        caminhoAtual = caminho

        superficie?.let { sv ->
            val saida = jogador.getVLCVout()
            saida.setVideoView(sv)
            if (sv.width > 0 && sv.height > 0) saida.setWindowSize(sv.width, sv.height)
            saida.attachViews()
        }

        val midia = Media(motor(), Uri.fromFile(arquivo))
        // Tocar antes do fim do download: o demuxer tem de aceitar um arquivo
        // que ainda cresce, e o cache precisa ser maior que o de um arquivo
        // parado em disco.
        midia.addOption(":file-caching=3000")
        midia.addOption(":clock-jitter=0")
        midia.addOption(":clock-synchro=0")
        if (posicao > 1) midia.addOption(":start-time=${posicao.toInt()}")
        jogador.media = midia
        midia.release()

        jogador.setEventListener { ev -> tratarEvento(ev) }

        volume = volumeInicial.coerceIn(0, 200)
        jogador.setVolume(volume)
        jogador.play()

        pausado = false
        tempo = posicao
        duracao = 0.0
        anotar("abri $caminho (posição ${posicao.toInt()}s)")

        return JSONObject()
            .put("ok", true)
            // No desktop isto dizia se o video coube dentro da janela; aqui a
            // superficie e sempre a da propria tela.
            .put("embutido", true)
            .put("caminho", caminho)
    }

    private fun tratarEvento(ev: MediaPlayer.Event) {
        when (ev.type) {
            MediaPlayer.Event.TimeChanged -> {
                tempo = ev.timeChanged / 1000.0
                propriedade("time-pos", tempo)
                if (duracao > 0 && progressoDoArquivo > 0) {
                    propriedade("demuxer-cache-time", duracao * progressoDoArquivo)
                }
            }
            MediaPlayer.Event.LengthChanged -> {
                duracao = ev.lengthChanged / 1000.0
                propriedade("duration", duracao)
            }
            MediaPlayer.Event.Playing -> {
                pausado = false
                propriedade("pause", false)
                propriedade("eof-reached", false)
                propriedade("paused-for-cache", false)
                evento("file-loaded")
                propriedade("track-list", JSONArray())
            }
            MediaPlayer.Event.Paused -> {
                pausado = true
                propriedade("pause", true)
            }
            MediaPlayer.Event.Stopped -> {
                propriedade("pause", true)
            }
            MediaPlayer.Event.EndReached -> {
                // Num torrent que ainda baixa, "fim" quase sempre quer dizer
                // "fim do que ja chegou" -- quem explica isso ao usuario e a
                // interface, que sabe se o download terminou.
                propriedade("eof-reached", true)
            }
            MediaPlayer.Event.EncounteredError -> {
                anotar("a libVLC encontrou um erro ao tocar $caminhoAtual")
                evento("encerrado")
            }
            MediaPlayer.Event.Buffering -> {
                val pct = ev.buffering
                propriedade("paused-for-cache", pct < 100f && mp?.isPlaying != true)
            }
            MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESSelected -> {
                propriedade("track-list", JSONArray())
            }
        }
    }

    // -------------------------------------------------------------- comandos

    /**
     * Os comandos do mpv que a interface manda. Qualquer outro devolve um
     * erro em vez de silencio: e assim que um comando esquecido aparece no
     * diagnostico em vez de virar um botao que nao faz nada.
     */
    @Synchronized
    fun comando(args: JSONArray): Any {
        val jogador = mp ?: throw Exception("player não está aberto")
        val verbo = args.optString(0)

        when (verbo) {
            "cycle" -> when (args.optString(1)) {
                "pause" -> {
                    if (jogador.isPlaying) jogador.pause() else jogador.play()
                    return true
                }
                "mute" -> {
                    mudo = !mudo
                    jogador.setVolume(if (mudo) 0 else volume)
                    propriedade("mute", mudo)
                    return true
                }
            }

            "seek" -> {
                val quanto = args.optDouble(1, 0.0)
                val modo = args.optString(2, "relative")
                val alvo = if (modo == "absolute") quanto else tempo + quanto
                val limite = if (duracao > 0) duracao else Double.MAX_VALUE
                jogador.setTime((alvo.coerceIn(0.0, limite) * 1000).toLong())
                tempo = alvo
                propriedade("time-pos", tempo)
                return true
            }

            "add" -> if (args.optString(1) == "volume") {
                definirVolume(volume + args.optInt(2, 0))
                return true
            }

            "set_property" -> {
                when (args.optString(1)) {
                    "volume" -> {
                        definirVolume(args.optInt(2, volume))
                        return true
                    }
                    "pause" -> {
                        if (args.optBoolean(2)) jogador.pause() else jogador.play()
                        return true
                    }
                    "mute" -> {
                        mudo = args.optBoolean(2)
                        jogador.setVolume(if (mudo) 0 else volume)
                        propriedade("mute", mudo)
                        return true
                    }
                    // "no" e como o mpv desliga uma faixa; a libVLC usa -1.
                    "aid" -> {
                        val v = args.optString(2)
                        jogador.setAudioTrack(if (v == "no") -1 else v.toIntOrNull() ?: -1)
                        return true
                    }
                    "sid" -> {
                        val v = args.optString(2)
                        jogador.setSpuTrack(if (v == "no") -1 else v.toIntOrNull() ?: -1)
                        return true
                    }
                }
            }

            "get_property" -> return when (args.optString(1)) {
                "time-pos" -> tempo
                "duration" -> duracao
                "pause" -> !jogador.isPlaying
                "volume" -> volume
                "mute" -> mudo
                "track-list" -> faixasCruas()
                "path" -> caminhoAtual
                else -> JSONObject.NULL
            }
        }

        throw Exception("comando desconhecido: ${args}")
    }

    private fun definirVolume(novo: Int) {
        volume = novo.coerceIn(0, 100)
        mudo = false
        mp?.setVolume(volume)
        propriedade("volume", volume)
    }

    fun informarProgressoDoArquivo(fracao: Double) {
        progressoDoArquivo = fracao.coerceIn(0.0, 1.0)
    }

    // ---------------------------------------------------------------- faixas

    private fun faixasCruas(): JSONArray = JSONArray()

    /**
     * Faixas de audio e legenda do arquivo aberto.
     *
     * Duas fontes fazem uma: o MediaPlayer sabe os identificadores e quais
     * estao selecionadas; a Media sabe codec, idioma e numero de canais. Sem
     * juntar as duas, o rotulo da faixa sairia so "Faixa 2".
     */
    @Synchronized
    fun faixas(): JSONObject {
        val jogador = mp ?: return JSONObject()
            .put("audio", JSONArray())
            .put("legenda", JSONArray())

        val detalhes = HashMap<Int, JSONObject>()
        try {
            val midia = jogador.getMedia()
            if (midia != null) {
                for (i in 0 until midia.trackCount) {
                    val t = midia.getTrack(i) ?: continue
                    val info = JSONObject()
                        .put("idioma", t.language ?: "")
                        .put("titulo", t.description ?: "")
                        .put("codec", t.originalCodec ?: t.codec ?: "")
                    if (t is IMedia.AudioTrack) info.put("canais", t.channels)
                    detalhes[t.id] = info
                }
            }
        } catch (e: Exception) {
            Diagnostico.anotar("player", "não consegui ler os detalhes das faixas: ${e.message}")
        }

        fun montar(descricoes: Array<MediaPlayer.TrackDescription>?, selecionada: Int): JSONArray {
            val saida = JSONArray()
            for (d in descricoes ?: emptyArray()) {
                if (d.id < 0) continue // "Desativar", que a interface ja oferece
                val info = detalhes[d.id]
                saida.put(
                    JSONObject()
                        .put("id", d.id)
                        .put("titulo", info?.optString("titulo")?.ifEmpty { d.name } ?: d.name ?: "")
                        .put("idioma", info?.optString("idioma") ?: "")
                        .put("codec", info?.optString("codec") ?: "")
                        .put("canais", info?.opt("canais") ?: JSONObject.NULL)
                        .put("padrao", false)
                        .put("selecionada", d.id == selecionada)
                        .put("externa", false)
                )
            }
            return saida
        }

        return JSONObject()
            .put("audio", montar(jogador.audioTracks, jogador.audioTrack))
            .put("legenda", montar(jogador.spuTracks, jogador.spuTrack))
    }

    // ------------------------------------------------------------ ciclo de vida

    @Synchronized
    fun fechar() {
        fecharInterno()
        evento("encerrado")
    }

    private fun fecharInterno() {
        mp?.let { jogador ->
            try {
                jogador.setEventListener(null)
                if (jogador.isPlaying) jogador.stop()
                jogador.getVLCVout().detachViews()
                jogador.release()
            } catch (e: Exception) {
                Diagnostico.anotarErro("player", e)
            }
        }
        mp = null
        caminhoAtual = ""
        duracao = 0.0
        tempo = 0.0
        progressoDoArquivo = 0.0
    }

    fun encerrar() {
        fecharInterno()
        try {
            vlc?.release()
        } catch (e: Exception) {
            // nada a fazer
        }
        vlc = null
    }

    /** O retrato que o painel de Ajustes mostra. */
    fun diagnostico(): JSONObject {
        val jogador = mp
        return JSONObject()
            .put("motor", "libVLC ${try { LibVLC.version() } catch (e: Exception) { "?" }}")
            .put("aberto", jogador != null)
            .put("caminho", caminhoAtual)
            .put("tocando", jogador?.isPlaying ?: false)
            .put("tempo", tempo)
            .put("duracao", duracao)
            .put("volume", volume)
            .put("mudo", mudo)
            .put("superficie", superficie?.let { "${it.width}x${it.height}" } ?: "(sem superfície)")
            .put("faixas", try { faixas() } catch (e: Exception) { JSONObject.NULL })
            .put("registro", JSONArray(registro.toList()))
    }
}
