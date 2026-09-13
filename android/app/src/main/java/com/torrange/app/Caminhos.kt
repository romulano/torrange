package com.torrange.app

import android.content.Context
import android.os.Environment
import java.io.File

/**
 * Onde cada coisa mora no aparelho.
 *
 * No desktop isto era `src/main/paths.js`, e a maior parte do arquivo cuidava
 * de achar o qbittorrent-nox e o mpv. Aqui nao ha binario para achar: os dois
 * viraram biblioteca dentro do processo. Sobrou a parte de pastas.
 *
 * A pasta de downloads padrao e a do proprio aplicativo
 * (Android/data/com.torrange.app/files/Movies/Torrange). E a unica que o
 * Android deixa um aplicativo ler e escrever com caminho de arquivo comum, que
 * e do que a libtorrent precisa -- e ela nao pede nenhuma permissao.
 */
object Caminhos {

    /** Dados do aplicativo: config, token, catalogo, capas, torrents. */
    fun dados(contexto: Context, vararg partes: String): File {
        var f = contexto.filesDir
        for (p in partes) f = File(f, p)
        return f
    }

    fun garantir(pasta: File): File {
        if (!pasta.exists()) pasta.mkdirs()
        return pasta
    }

    fun config(contexto: Context) = dados(contexto, "config.json")
    fun instalacao(contexto: Context) = dados(contexto, "instalacao.json")
    fun token(contexto: Context) = dados(contexto, "token.bin")
    fun biblioteca(contexto: Context) = dados(contexto, "biblioteca.json")
    fun organizacao(contexto: Context) = dados(contexto, "organizacao.json")
    fun fila(contexto: Context) = dados(contexto, "fila.json")

    fun capas(contexto: Context) = garantir(dados(contexto, "capas"))
    fun torrents(contexto: Context) = garantir(dados(contexto, "torrents"))
    fun retomada(contexto: Context) = garantir(dados(contexto, "retomada"))
    fun diagnosticos(contexto: Context) = garantir(dados(contexto, "diagnosticos"))

    /** Pasta de downloads de fabrica. */
    fun downloadsPadrao(contexto: Context): File {
        val externa = contexto.getExternalFilesDir(Environment.DIRECTORY_MOVIES)
            ?: File(contexto.filesDir, "Movies")
        return File(externa, "Torrange")
    }

    /**
     * As pastas que o usuario pode escolher em Ajustes.
     *
     * A lista e curta de proposito: sao os lugares em que o aplicativo escreve
     * sem pedir permissao nenhuma. Escolher uma pasta qualquer do cartao
     * exigiria MANAGE_EXTERNAL_STORAGE, que e permissao de gerenciador de
     * arquivos -- desproporcional para um cliente de torrent.
     */
    fun pastasPossiveis(contexto: Context): List<File> {
        val lista = mutableListOf<File>()
        for (raiz in contexto.getExternalFilesDirs(Environment.DIRECTORY_MOVIES)) {
            if (raiz != null) lista.add(File(raiz, "Torrange"))
        }
        if (lista.isEmpty()) lista.add(downloadsPadrao(contexto))
        lista.add(File(contexto.filesDir, "Torrange"))
        return lista.distinctBy { it.absolutePath }
    }

    /** Quanto ainda cabe na pasta de downloads. */
    fun espacoLivre(pasta: File): Long = try {
        garantir(pasta).usableSpace
    } catch (e: Exception) {
        -1L
    }
}
