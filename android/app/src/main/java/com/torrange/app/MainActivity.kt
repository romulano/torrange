package com.torrange.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.ConsoleMessage
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

/**
 * A tela.
 *
 * Ela e uma WebView com a MESMA interface do aplicativo de desktop (os
 * arquivos de `src/renderer/` vao para os assets na hora do build) e, por
 * cima, uma SurfaceView onde a libVLC desenha o video.
 *
 * A sobreposicao e o mesmo truque do desktop: la o mpv ganhava uma janela
 * filha posicionada sobre a area de video; aqui a superficie e posta no
 * retangulo que a propria interface informa pelo canal `ui:layout`. Por isso a
 * area de video da interface e um buraco -- o que aparece nela nao e HTML.
 */
class MainActivity : AppCompatActivity(), Ponte.Tela {

    companion object {
        /**
         * O mesmo dominio do WebViewAssetLoader do AndroidX. Nao existe de
         * verdade: tudo o que a pagina pede e respondido aqui dentro, sem rede
         * e sem TLS. Uma origem https propria e o que faz a WebView tratar a
         * interface como um site normal (localStorage, fetch, CSP) em vez de
         * um file:// cheio de restricoes.
         */
        const val ORIGEM = "https://appassets.androidplatform.net"
        const val INICIO = "$ORIGEM/index.html"
    }

    private lateinit var raiz: FrameLayout
    private lateinit var webview: WebView
    private lateinit var superficie: SurfaceView
    private lateinit var ponte: Ponte

    private val nucleo: Nucleo by lazy { (application as Aplicativo).nucleo }

    private var areaDeVideo: JSONObject? = null
    private var emTelaCheia = false
    private var abaAtual = "acervo"
    private var recortes = JSONObject()

    private var retornoDeTorrents: ((List<Uri>) -> Unit)? = null
    private var retornoDeImagem: ((Uri?) -> Unit)? = null

    private val escolherTorrentsLauncher =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            retornoDeTorrents?.invoke(uris ?: emptyList())
            retornoDeTorrents = null
        }

    private val escolherImagemLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            retornoDeImagem?.invoke(uri)
            retornoDeImagem = null
        }

    private val pedirNotificacoes =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* opcional */ }

    // ------------------------------------------------------------ ciclo de vida

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(estadoSalvo: Bundle?) {
        super.onCreate(estadoSalvo)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        raiz = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0b0d12")) }
        setContentView(raiz)

        webview = WebView(this)
        raiz.addView(
            webview,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        // A superficie entra DEPOIS da WebView (fica por cima) e so aparece
        // quando ha video: uma superficie preta parada sobre a interface
        // esconderia metade da tela.
        superficie = SurfaceView(this).apply { visibility = View.GONE }
        raiz.addView(superficie, FrameLayout.LayoutParams(1, 1))

        aplicarRecortes()
        configurarWebView()

        ponte = Ponte(nucleo, this)
        webview.addJavascriptInterface(ponte, "TorrangePonte")

        nucleo.player.configurar(superficie) { evento -> emitirParaInterface("player:evento", evento) }
        nucleo.ouvinte = { canal, dados -> emitirParaInterface(canal, dados) }
        nucleo.iniciar()

        webview.loadUrl(INICIO)

        if (android.os.Build.VERSION.SDK_INT >= 33 && !Notificacoes.podeNotificar(this)) {
            pedirNotificacoes.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        ServicoTorrange.ligar(this)
        tratarIntencao(intent)
        ligarBotaoVoltar()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        tratarIntencao(intent)
    }

    /** Um magnet ou um .torrent compartilhado de outro aplicativo. */
    private fun tratarIntencao(intent: Intent?) {
        val dados = intent?.data ?: return
        nucleo.escopo.launch {
            when {
                dados.scheme == "magnet" -> nucleo.receberMagnet(dados.toString())
                else -> nucleo.receberArquivos(listOf(dados))
            }
        }
    }

    override fun onResume() {
        super.onResume()
        nucleo.motor.continuar()
    }

    override fun onPause() {
        super.onPause()
        // Sem "baixar em segundo plano", a sessao para junto com a tela: e o
        // ajuste de quem nao quer o aparelho baixando no 4G no bolso.
        if (!nucleo.config.ligado("baixarEmSegundoPlano")) nucleo.motor.suspender()
    }

    override fun onDestroy() {
        nucleo.ouvinte = null
        if (isFinishing) {
            nucleo.encerrar()
            ServicoTorrange.desligar(this)
        }
        super.onDestroy()
    }

    private fun ligarBotaoVoltar() {
        onBackPressedDispatcher.addCallback(this) {
            // Quem decide e a interface: com um painel aberto, "voltar" fecha o
            // painel; no player, fecha o player; so na tela inicial e que o
            // aplicativo sai.
            webview.evaluateJavascript("window.__torrangeVoltar && window.__torrangeVoltar()") { r ->
                if (r != "true") finish()
            }
        }
    }

    // -------------------------------------------------------------- a WebView

    private fun configurarWebView() {
        webview.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            // A interface do desktop ja e responsiva o bastante; deixar a
            // WebView "encolher a pagina" como um navegador de celular faria
            // tudo sair com 3 pt de altura.
            useWideViewPort = false
            loadWithOverviewMode = false
            textZoom = 100
        }
        webview.setBackgroundColor(Color.parseColor("#0e1013"))
        webview.isVerticalScrollBarEnabled = false
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        /*
         * Sem um WebChromeClient, a WebView ENGOLE window.confirm() e
         * window.prompt(): não mostra nada e devolve false/null na hora. A
         * interface usa os dois em quatro lugares -- remover um torrent,
         * desconectar o aparelho, excluir uma pasta e criar uma pasta --, e
         * todos ficavam mudos: o toque na lixeira simplesmente não fazia nada.
         *
         * Aqui cada um vira uma caixa de diálogo de verdade do Android. A
         * resposta volta pelo mesmo caminho que o navegador usaria, então a
         * interface continua sendo a mesma das outras plataformas.
         */
        webview.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(v: WebView?, url: String?, mensagem: String?, r: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(mensagem)
                    .setPositiveButton("OK") { _, _ -> r.confirm() }
                    .setOnCancelListener { r.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(v: WebView?, url: String?, mensagem: String?, r: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(mensagem)
                    .setPositiveButton("OK") { _, _ -> r.confirm() }
                    .setNegativeButton("Cancelar") { _, _ -> r.cancel() }
                    .setOnCancelListener { r.cancel() }
                    .show()
                return true
            }

            override fun onJsPrompt(
                v: WebView?, url: String?, mensagem: String?, padrao: String?, r: JsPromptResult
            ): Boolean {
                val campo = EditText(this@MainActivity).apply {
                    setText(padrao ?: "")
                    setSelection(text.length)
                }
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(mensagem)
                    .setView(campo)
                    .setPositiveButton("OK") { _, _ -> r.confirm(campo.text.toString()) }
                    .setNegativeButton("Cancelar") { _, _ -> r.cancel() }
                    .setOnCancelListener { r.cancel() }
                    .show()
                return true
            }

            /** O console da interface entra no arquivo de diagnóstico. */
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Diagnostico.anotar(
                    "interface",
                    "[${m.messageLevel()}] ${m.message()} (${m.sourceId()}:${m.lineNumber()})"
                )
                return true
            }
        }

        webview.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                pedido: WebResourceRequest?
            ): WebResourceResponse? = servir(pedido?.url)

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                pedido: WebResourceRequest?
            ): Boolean {
                val url = pedido?.url?.toString() ?: return false
                // Qualquer link para fora (o site, a pagina de aplicativos) vai
                // para o navegador do sistema, nunca para dentro da interface.
                if (!url.startsWith(ORIGEM)) {
                    abrirNoNavegador(url)
                    return true
                }
                return false
            }
        }
    }

    /**
     * Serve a interface e as imagens.
     *
     * No desktop havia dois esquemas proprios registrados no Electron:
     * `capa://img/<arquivo>` para as capas que o usuario escolheu e
     * `acervo://capa/<item>` para as do acervo, que so a API entrega e so com
     * o token. Aqui os dois viraram caminhos dentro da mesma origem -- e o
     * token continua sem nunca aparecer na interface.
     */
    private fun servir(url: Uri?): WebResourceResponse? {
        if (url == null || !url.toString().startsWith(ORIGEM)) return null
        // encodedPath, e nao path: o caminho e decodificado uma vez so, logo
        // abaixo. Decodificar duas vezes estragaria um nome com "%" dentro.
        val caminho = url.encodedPath?.trimStart('/') ?: return null

        try {
            // as capas da biblioteca, copiadas para os dados do aplicativo
            if (caminho.startsWith("capa/img/")) {
                val nome = Uri.decode(caminho.removePrefix("capa/img/"))
                val capa = nucleo.metadados.lerCapa(nome) ?: return vazio(404)
                return resposta(capa.second, capa.first)
            }

            // as capas do acervo, buscadas pelo nucleo (com o token) e guardadas
            if (caminho.startsWith("acervo/capa/")) {
                val item = Uri.decode(caminho.removePrefix("acervo/capa/"))
                if (!Regex("^[A-Za-z0-9_-]{1,64}$").matches(item)) return vazio(400)
                val capa = nucleo.capaDoAcervo(item) ?: return vazio(404)
                return resposta(capa.second, capa.first)
            }

            val arquivo = if (caminho.isEmpty()) "index.html" else caminho
            val fluxo = assets.open("app/$arquivo")
            return WebResourceResponse(tipoDe(arquivo), "utf-8", 200, "OK", cabecalhos(), fluxo)
        } catch (e: Exception) {
            return vazio(404)
        }
    }

    private fun cabecalhos() = mapOf("Cache-Control" to "no-cache")

    private fun resposta(tipo: String, bytes: ByteArray) =
        WebResourceResponse(tipo, null, 200, "OK", cabecalhos(), ByteArrayInputStream(bytes))

    private fun vazio(codigo: Int) = WebResourceResponse(
        "text/plain", "utf-8", codigo, if (codigo == 404) "Not Found" else "Bad Request",
        cabecalhos(), ByteArrayInputStream(ByteArray(0))
    )

    private fun tipoDe(arquivo: String): String = when (arquivo.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "js" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    // ---------------------------------------------------- eventos para a interface

    private fun emitirParaInterface(canal: String, dados: Any) {
        val texto = when (dados) {
            is JSONObject, is JSONArray -> dados.toString()
            is String -> JSONObject.quote(dados)
            else -> dados.toString()
        }
        runOnUiThread {
            webview.evaluateJavascript(
                "window.__torrangeEvento && window.__torrangeEvento(${JSONObject.quote(canal)}, $texto)",
                null
            )
        }
    }

    override fun responder(id: Int, ok: Boolean, valor: String) {
        runOnUiThread {
            webview.evaluateJavascript(
                "window.__torrangeResposta && window.__torrangeResposta($id, $ok, $valor)",
                null
            )
        }
    }

    // --------------------------------------------------------------- a superficie

    override fun aba(nome: String) {
        abaAtual = nome
        runOnUiThread { aplicarLayout() }
    }

    override fun layout(retangulo: JSONObject?) {
        areaDeVideo = retangulo?.optJSONObject("player") ?: retangulo
        runOnUiThread { aplicarLayout() }
    }

    /**
     * Poe a superficie exatamente onde a interface desenhou a area de video.
     *
     * A interface fala em pixels de CSS; a View fala em pixels do aparelho.
     * Errar essa conta e o que faz o video aparecer deslocado num telefone de
     * tela densa e certinho num emulador -- por isso a densidade entra aqui.
     */
    private fun aplicarLayout() {
        val r = areaDeVideo
        val mostrar = abaAtual == "player" && nucleo.player.aberto && r != null

        if (!mostrar) {
            superficie.visibility = View.GONE
            return
        }

        val d = resources.displayMetrics.density
        val p = superficie.layoutParams as FrameLayout.LayoutParams
        p.width = (r!!.optDouble("width", 0.0) * d).toInt().coerceAtLeast(1)
        p.height = (r.optDouble("height", 0.0) * d).toInt().coerceAtLeast(1)
        p.leftMargin = (r.optDouble("x", 0.0) * d).toInt()
        p.topMargin = (r.optDouble("y", 0.0) * d).toInt()
        superficie.layoutParams = p
        superficie.visibility = View.VISIBLE
        superficie.keepScreenOn = true
    }

    override fun telaCheia(ligar: Boolean) {
        emTelaCheia = ligar
        runOnUiThread {
            val controle = WindowInsetsControllerCompat(window, window.decorView)
            if (ligar) {
                controle.hide(WindowInsetsCompat.Type.systemBars())
                controle.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            } else {
                controle.show(WindowInsetsCompat.Type.systemBars())
                requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            emitirParaInterface(
                "player:evento",
                JSONObject().put("tipo", "tela-cheia").put("valor", ligar)
            )
        }
    }

    /**
     * A barra de status e a de navegacao nao podem cobrir a interface. Como a
     * interface e uma pagina, o recuo vai para ela como variaveis de CSS.
     */
    private fun aplicarRecortes() {
        ViewCompat.setOnApplyWindowInsetsListener(raiz) { _, recortesDaJanela ->
            val barras = recortesDaJanela.getInsets(WindowInsetsCompat.Type.systemBars())
            val d = resources.displayMetrics.density
            recortes = JSONObject()
                .put("topo", barras.top / d)
                .put("base", barras.bottom / d)
                .put("esquerda", barras.left / d)
                .put("direita", barras.right / d)
            webview.evaluateJavascript(
                "window.__torrangeRecortes && window.__torrangeRecortes($recortes)", null
            )
            recortesDaJanela
        }
    }

    // ------------------------------------------------------------------ escolhas

    override fun escolherTorrents(retorno: (List<Uri>) -> Unit) {
        runOnUiThread {
            retornoDeTorrents = retorno
            try {
                escolherTorrentsLauncher.launch(
                    arrayOf("application/x-bittorrent", "application/octet-stream", "*/*")
                )
            } catch (e: Exception) {
                retornoDeTorrents = null
                retorno(emptyList())
            }
        }
    }

    override fun escolherImagem(retorno: (Uri?) -> Unit) {
        runOnUiThread {
            retornoDeImagem = retorno
            try {
                escolherImagemLauncher.launch("image/*")
            } catch (e: Exception) {
                retornoDeImagem = null
                retorno(null)
            }
        }
    }

    /**
     * Escolher a pasta de downloads.
     *
     * Aqui a tela e diferente da do desktop, e por um motivo de sistema: no
     * Android um aplicativo escreve com caminho de arquivo comum apenas nas
     * pastas dele (uma na memoria interna, outra no cartao). Qualquer outra
     * exigiria a permissao de gerenciador de arquivos -- desproporcional para
     * um cliente de torrent, e a libtorrent nao escreve por content://.
     */
    override fun escolherPasta(retorno: (String?) -> Unit) {
        runOnUiThread {
            val opcoes = Caminhos.pastasPossiveis(this)
            // setItems pede CharSequence[]: um Array<String> nao serve no lugar.
            val rotulos: Array<CharSequence> = opcoes.map { pasta ->
                val livre = Caminhos.espacoLivre(pasta) / 1024.0 / 1024.0 / 1024.0
                val onde = if (pasta.absolutePath.contains("/storage/emulated/0") ||
                    pasta.absolutePath.startsWith(filesDir.absolutePath)
                ) "memória interna" else "cartão de memória"
                "$onde\n${pasta.absolutePath}\n%.1f GB livres".format(livre)
            }.toTypedArray()

            AlertDialog.Builder(this)
                .setTitle("Onde salvar os downloads")
                .setItems(rotulos) { _, i -> retorno(opcoes[i].absolutePath) }
                .setNegativeButton("Cancelar") { _, _ -> retorno(null) }
                .setOnCancelListener { retorno(null) }
                .show()
        }
    }

    override fun abrirNoNavegador(url: String) {
        runOnUiThread {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: Exception) {
                nucleo.avisar("Não encontrei um navegador para abrir $url", "erro")
            }
        }
    }

    /**
     * Abrir um arquivo gerado pelo aplicativo (o .log de diagnostico).
     *
     * O arquivo mora na area privada do aplicativo, entao o caminho nu nao
     * serve para mais ninguem: quem sai daqui e um content:// temporario, que
     * so vale para quem recebeu.
     */
    override fun abrirArquivo(caminho: String) {
        if (caminho.isEmpty()) return
        runOnUiThread {
            try {
                val arquivo = File(caminho)
                val uri = FileProvider.getUriForFile(this, "$packageName.arquivos", arquivo)
                val intencao = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .putExtra(Intent.EXTRA_SUBJECT, arquivo.name)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                startActivity(Intent.createChooser(intencao, "Enviar o diagnóstico"))
            } catch (e: Exception) {
                nucleo.avisar("Não consegui abrir $caminho: ${e.message}", "erro")
            }
        }
    }

    override fun retrato(): JSONObject = JSONObject()
        .put("areaDeVideo", areaDeVideo ?: JSONObject.NULL)
        .put("aba", abaAtual)
        .put("telaCheia", emTelaCheia)
        .put("recortes", recortes)
        .put(
            "janela",
            JSONObject()
                .put("largura", resources.displayMetrics.widthPixels)
                .put("altura", resources.displayMetrics.heightPixels)
                .put("densidade", resources.displayMetrics.density)
        )
}
