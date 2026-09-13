package com.torrange.app

import android.net.Uri
import android.webkit.JavascriptInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * A ponte entre a interface (a mesma do desktop, rodando numa WebView) e o
 * nucleo.
 *
 * No desktop havia duas metades: um `preload.js` que expunha `window.torrange`
 * e o `ipcMain` do lado do processo principal. Aqui a metade de cima continua
 * sendo JavaScript (`android-preload.js`, nos assets) e a de baixo e esta
 * classe -- os NOMES DOS CANAIS sao os mesmos dos dois lados, de proposito:
 * e o que permite a interface vir do desktop sem uma linha alterada.
 *
 * Repare no que NAO esta aqui, como no desktop: nao ha canal para LER o token.
 * A interface so o escreve e ve a forma mascarada.
 */
class Ponte(private val nucleo: Nucleo, private val tela: Tela) {

    /** O que so a tela pode fazer: escolher arquivos, abrir coisas, tela cheia. */
    interface Tela {
        fun escolherTorrents(retorno: (List<Uri>) -> Unit)
        fun escolherImagem(retorno: (Uri?) -> Unit)
        fun escolherPasta(retorno: (String?) -> Unit)
        fun aba(nome: String)
        fun layout(retangulo: JSONObject?)
        fun telaCheia(ligar: Boolean)
        fun abrirNoNavegador(url: String)
        fun abrirArquivo(caminho: String)
        fun retrato(): JSONObject
        fun responder(id: Int, ok: Boolean, valor: String)
    }

    // ------------------------------------------------------------- entrada

    /**
     * Toda chamada que espera resposta entra por aqui. Roda fora da linha da
     * interface (a WebView chamaria numa linha propria, mas rede e disco nao
     * podem prender nem essa) e responde pelo `responder`.
     */
    @JavascriptInterface
    fun chamar(id: Int, canal: String, argumentos: String) {
        nucleo.escopo.launch(Dispatchers.IO) {
            try {
                val args = try {
                    JSONArray(argumentos)
                } catch (e: Exception) {
                    JSONArray()
                }
                val valor = despachar(canal, args)
                tela.responder(id, true, empacotar(valor))
            } catch (e: Throwable) {
                Diagnostico.anotar("ponte", "$canal falhou: ${e.message}")
                tela.responder(id, false, JSONObject.quote(e.message ?: "falha em $canal"))
            }
        }
    }

    /** Os canais que nao devolvem nada (o `ipcRenderer.send` do desktop). */
    @JavascriptInterface
    fun enviar(canal: String, argumentos: String) {
        try {
            val args = try {
                JSONArray(argumentos)
            } catch (e: Exception) {
                JSONArray()
            }
            when (canal) {
                "ui:aba" -> tela.aba(args.optString(0))
                "ui:layout" -> tela.layout(args.optJSONObject(0))
                "ui:tela-cheia" -> tela.telaCheia(args.optBoolean(0))

                "player:posicao" -> {
                    val d = args.optJSONObject(0) ?: return
                    val hash = d.optString("hash")
                    val caminho = d.optString("caminho")
                    if (hash.isNotEmpty() && caminho.isNotEmpty()) {
                        nucleo.biblioteca.salvarPosicao(
                            hash, caminho, d.optDouble("segundos", 0.0), d.optDouble("duracao", 0.0)
                        )
                    }
                }

                "app:log" -> {
                    val d = args.optJSONObject(0) ?: return
                    Diagnostico.anotar(d.optString("origem").ifEmpty { "interface" }, d.optString("texto"))
                }
            }
        } catch (e: Throwable) {
            Diagnostico.anotar("ponte", "$canal falhou: ${e.message}")
        }
    }

    private fun empacotar(valor: Any?): String = when (valor) {
        null, JSONObject.NULL -> "null"
        is JSONObject, is JSONArray -> valor.toString()
        is String -> JSONObject.quote(valor)
        is Boolean, is Int, is Long, is Double, is Float -> valor.toString()
        else -> JSONObject.quote(valor.toString())
    }

    /**
     * Espera por uma escolha da tela (seletor de arquivo, de pasta).
     *
     * Prender aqui e seguro: quem chama e uma corrotina de IO, nunca a linha
     * da interface -- e a resposta do seletor vem justamente pela linha da
     * interface, que continua livre.
     */
    private fun aguardar(pedir: ((Any?) -> Unit) -> Unit): Any? {
        val fila = java.util.concurrent.ArrayBlockingQueue<Array<Any?>>(1)
        pedir { valor -> fila.offer(arrayOf(valor)) }
        return fila.take()[0]
    }

    // ------------------------------------------------------------- despacho

    private fun despachar(canal: String, args: JSONArray): Any? {
        return when (canal) {

            // ------------------------------------------------------------ conexao
            "conexao:estado" -> nucleo.conexao.atual()

            "conexao:definir-token" -> {
                val r = nucleo.conexao.definirToken(args.optString(0), nucleo.config)
                if (r.optBoolean("ok")) nucleo.limparCapas() // outra conta enxerga outro acervo
                r
            }

            "conexao:esquecer" -> {
                nucleo.limparCapas()
                nucleo.conexao.esquecerToken()
            }

            "conexao:verificar" -> nucleo.conexao.reverificar(nucleo.config)

            "conexao:abrir-site" -> {
                tela.abrirNoNavegador(nucleo.conexao.paginaAplicativos())
                true
            }

            // ------------------------------------------------------------- acervo
            "acervo:listar" -> nucleo.chamarApi { nucleo.api.acervo(comoMapa(args.optJSONObject(0))) }
            "acervo:titulo" -> nucleo.chamarApi { nucleo.api.titulo(args.optString(0)) }
            "acervo:favoritos" -> nucleo.chamarApi { nucleo.api.favoritos(args.optInt(0, 1)) }
            "acervo:baixados" -> nucleo.chamarApi { nucleo.api.baixados(args.optInt(0, 1)) }
            "acervo:favoritar" -> nucleo.chamarApi {
                nucleo.api.alternarFavorito(args.optString(0), args.optString(1).ifEmpty { null })
            }
            "acervo:baixar" -> nucleo.baixarDoAcervo(args.optString(0))
            "acervo:confirmar" -> nucleo.confirmarDownload(args.optString(0), args.optDouble(1, 0.0))

            // --------------------------------------------------------------- fila
            "fila:listar" -> nucleo.biblioteca.snapshot()

            "fila:pausar" -> {
                nucleo.motor.pausar(args.optString(0))
                nucleo.atualizar()
                true
            }

            "fila:retomar" -> {
                nucleo.motor.retomar(args.optString(0))
                nucleo.atualizar()
                true
            }

            "fila:remover" -> {
                nucleo.motor.remover(args.optString(0), args.optBoolean(1))
                nucleo.atualizar()
                true
            }

            "fila:magnet" -> nucleo.receberMagnet(args.optString(0))
            "fila:url" -> nucleo.receberUrl(args.optString(0))

            "fila:arquivo" -> {
                @Suppress("UNCHECKED_CAST")
                val uris = aguardar { r -> tela.escolherTorrents { lista -> r(lista) } } as? List<Uri>
                if (uris.isNullOrEmpty()) JSONObject().put("cancelado", true)
                else nucleo.receberArquivos(uris)
            }

            // -------------------------------------- motor (o "qbit" da interface)
            "qbit:estado" -> nucleo.estadoMotor()
            "qbit:tentar" -> nucleo.tentarMotorDeNovo()
            "qbit:registro" -> JSONObject()
                .put("estado", nucleo.estadoMotor())
                .put("binario", "libtorrent4j (embutida no aplicativo)")
                .put("porta", nucleo.motor.diagnostico().opt("porta"))
                .put("ultimoErro", nucleo.motor.ultimoErro().ifEmpty { JSONObject.NULL })
                .put("linhas", JSONArray(nucleo.motor.registro()))

            // --------------------------------------------------------- biblioteca
            "biblioteca:listar" -> nucleo.metadados.aplicar(nucleo.biblioteca.listar())
            "biblioteca:pastas" -> nucleo.metadados.pastasParaInterface()
            "biblioteca:criar-pasta" -> nucleo.metadados.criarPasta(args.optJSONObject(0) ?: JSONObject())
            "biblioteca:editar-pasta" ->
                nucleo.metadados.editarPasta(args.optString(0), args.optJSONObject(1) ?: JSONObject())
            "biblioteca:remover-pasta" -> nucleo.metadados.removerPasta(args.optString(0))

            "biblioteca:editar-titulo" -> {
                nucleo.metadados.editarTitulo(args.optString(0), args.optJSONObject(1) ?: JSONObject())
                nucleo.atualizar()
                true
            }

            "biblioteca:editar-arquivo" -> {
                nucleo.metadados.editarArquivo(args.optString(0), args.optString(1), args.optString(2))
                nucleo.atualizar()
                true
            }

            "biblioteca:capa" -> {
                val alvo = args.optJSONObject(0) ?: JSONObject()
                var origem = args.optJSONObject(1) ?: JSONObject()
                if (origem.optBoolean("escolher")) {
                    val uri = aguardar { r -> tela.escolherImagem { u -> r(u) } } as? Uri
                        ?: return JSONObject().put("cancelado", true)
                    origem = JSONObject().put("arquivo", uri.toString())
                }
                try {
                    nucleo.metadados.definirCapa(alvo, origem)
                    nucleo.atualizar()
                    JSONObject().put("ok", true)
                } catch (e: Exception) {
                    JSONObject().put("erro", e.message ?: "falha")
                }
            }

            "biblioteca:remover-capa" -> {
                nucleo.metadados.removerCapa(args.optJSONObject(0) ?: JSONObject())
                nucleo.atualizar()
                true
            }

            // --------------------------------------------------------- aplicativo
            "app:info" -> nucleo.info()

            "app:diagnostico" -> nucleo.gerarDiagnostico(tela.retrato())

            "app:abrir-arquivo" -> {
                tela.abrirArquivo(args.optString(0))
                true
            }

            "app:abrir-pasta" -> {
                tela.abrirArquivo(args.optString(0))
                true
            }

            // -------------------------------------------------------------- player
            "player:abrir" -> {
                val d = args.optJSONObject(0) ?: JSONObject()
                val hash = d.optString("hash")
                val caminho = d.optString("caminho")
                val posicao = if (hash.isNotEmpty()) nucleo.biblioteca.posicaoDe(hash, caminho) else 0.0
                nucleo.hashNoPlayer = hash
                nucleo.caminhoNoPlayer = caminho
                val r = nucleo.player.abrir(caminho, posicao, nucleo.config.numero("volume"))
                tela.aba("player")
                r.put("posicao", posicao)
            }

            "player:comando" -> {
                // O desktop mandava os argumentos do mpv num array so; mantivemos.
                val lista = args.optJSONArray(0) ?: args
                try {
                    nucleo.player.comando(lista)
                } catch (e: Exception) {
                    JSONObject().put("erro", e.message ?: "falha")
                }
            }

            "player:faixas" -> nucleo.player.faixas()

            "player:diagnostico" -> nucleo.player.diagnostico()
                .put("videoAcoplavel", true)
                .put("areaDeVideoPedida", tela.retrato().opt("areaDeVideo"))
                .put("janelaPrincipal", tela.retrato().opt("janela"))

            "player:fechar" -> {
                nucleo.player.fechar()
                nucleo.hashNoPlayer = ""
                nucleo.caminhoNoPlayer = ""
                true
            }

            // -------------------------------------------------------------- config
            "config:ler" -> nucleo.config.ler()

            "config:gravar" -> {
                val parcial = args.optJSONObject(0)
                val novo = nucleo.config.gravar(parcial)
                if (parcial != null && parcial.has("apiUrl")) {
                    nucleo.api.configurar(novo.optString("apiUrl"))
                    nucleo.limparCapas()
                }
                nucleo.conexao.configurar(nucleo.config)
                nucleo.motor.aplicarPreferencias()
                novo
            }

            "config:escolher-pasta" -> {
                val escolhida = aguardar { r -> tela.escolherPasta { p -> r(p) } } as? String
                if (escolhida == null) JSONObject.NULL
                else {
                    val novo = nucleo.config.gravar(JSONObject().put("pastaDownloads", escolhida))
                    nucleo.motor.aplicarPreferencias()
                    novo
                }
            }

            else -> throw Exception("canal desconhecido: $canal")
        }
    }

    private fun comoMapa(objeto: JSONObject?): Map<String, Any?> {
        if (objeto == null) return emptyMap()
        val mapa = HashMap<String, Any?>()
        for (chave in objeto.keys()) {
            val valor = objeto.opt(chave)
            if (valor == null || valor == JSONObject.NULL) continue
            mapa[chave] = valor
        }
        return mapa
    }
}
