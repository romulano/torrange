package com.torrange.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * O servico que segura a sessao viva.
 *
 * No desktop o qBittorrent era um processo separado e continuava baixando
 * enquanto a janela estivesse aberta. No Android nao existe "processo
 * separado" para um aplicativo comum: sem um servico em primeiro plano, o
 * sistema congela tudo poucos minutos depois de a tela apagar e o download
 * para no meio.
 *
 * A barra de notificacao que aparece nao e enfeite: e ela que compra esse
 * tempo do sistema, e por isso mostra o que esta acontecendo.
 */
class ServicoTorrange : Service() {

    private var trava: PowerManager.WakeLock? = null

    companion object {
        fun ligar(contexto: Context) {
            val intencao = Intent(contexto, ServicoTorrange::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                contexto.startForegroundService(intencao)
            } else {
                contexto.startService(intencao)
            }
        }

        fun desligar(contexto: Context) {
            contexto.stopService(Intent(contexto, ServicoTorrange::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val aviso = Notificacoes.daBarra(this, "Mantendo os downloads em andamento")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(Notificacoes.ID_SERVICO, aviso, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(Notificacoes.ID_SERVICO, aviso)
        }

        // Sem isto o proprio processador dorme e a sessao para de responder aos
        // pares mesmo com o servico no ar.
        val energia = getSystemService(POWER_SERVICE) as PowerManager
        trava = energia.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "torrange:downloads").apply {
            setReferenceCounted(false)
            acquire(6 * 60 * 60 * 1000L) // teto de seguranca: 6 horas
        }

        Diagnostico.anotar("servico", "no ar")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        try {
            trava?.release()
        } catch (e: Exception) {
            // ja tinha sido solta
        }
        trava = null
        Diagnostico.anotar("servico", "encerrado")
        super.onDestroy()
    }
}
