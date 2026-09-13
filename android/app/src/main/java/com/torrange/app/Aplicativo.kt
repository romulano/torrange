package com.torrange.app

import android.app.Application

/**
 * O processo do aplicativo. O nucleo mora aqui (e nao na Activity) porque o
 * download continua com a tela fechada: se a sessao da libtorrent morresse
 * junto com a tela, girar o aparelho cancelaria o download.
 */
class Aplicativo : Application() {

    val nucleo: Nucleo by lazy { Nucleo(this) }

    override fun onCreate() {
        super.onCreate()
        Diagnostico.capturarExcecoes()
        Diagnostico.anotar("app", "processo criado")
        Notificacoes.criarCanais(this)
    }
}
