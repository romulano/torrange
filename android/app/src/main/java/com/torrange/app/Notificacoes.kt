package com.torrange.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Os avisos do sistema. No desktop isto era a Notification do Electron; aqui
 * sao dois canais: um silencioso, para a barra do servico que segura os
 * downloads vivos, e outro para "comecou" e "terminou".
 */
object Notificacoes {

    const val CANAL_SERVICO = "torrange-servico"
    const val CANAL_AVISOS = "torrange-avisos"
    const val ID_SERVICO = 1
    private var proximo = 100

    fun criarCanais(contexto: Context) {
        val gerente = contexto.getSystemService(NotificationManager::class.java) ?: return

        gerente.createNotificationChannel(
            NotificationChannel(
                CANAL_SERVICO,
                "Downloads em andamento",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "A barra que mantém os downloads vivos com o aplicativo fechado."
                setShowBadge(false)
            }
        )

        gerente.createNotificationChannel(
            NotificationChannel(
                CANAL_AVISOS,
                "Avisos",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Quando um download começa e quando termina."
            }
        )
    }

    private fun aoTocar(contexto: Context): PendingIntent =
        PendingIntent.getActivity(
            contexto,
            0,
            Intent(contexto, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )

    fun daBarra(contexto: Context, texto: String): Notification =
        NotificationCompat.Builder(contexto, CANAL_SERVICO)
            .setContentTitle("Torrange")
            .setContentText(texto)
            .setSmallIcon(R.drawable.ic_notificacao)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(aoTocar(contexto))
            .build()

    fun atualizarBarra(contexto: Context, texto: String) {
        if (!podeNotificar(contexto)) return
        contexto.getSystemService(NotificationManager::class.java)
            ?.notify(ID_SERVICO, daBarra(contexto, texto))
    }

    fun mostrar(contexto: Context, titulo: String, texto: String) {
        if (!podeNotificar(contexto)) return
        val aviso = NotificationCompat.Builder(contexto, CANAL_AVISOS)
            .setContentTitle(titulo)
            .setContentText(texto)
            .setSmallIcon(R.drawable.ic_notificacao)
            .setAutoCancel(true)
            .setContentIntent(aoTocar(contexto))
            .build()
        contexto.getSystemService(NotificationManager::class.java)?.notify(proximo++, aviso)
    }

    /** A partir do Android 13 a permissao e pedida; sem ela, nao adianta tentar. */
    fun podeNotificar(contexto: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(
                contexto, android.Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
}
