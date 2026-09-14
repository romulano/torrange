package com.torrange.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.Inet6Address

/**
 * De qual endereço a libtorrent deve falar.
 *
 * A libtorrent descobre as interfaces do aparelho lendo a tabela de rotas do
 * sistema. No Android isso não funciona: o dump de rotas do NETLINK é barrado
 * para aplicativos comuns, e a biblioteca registra
 *
 *     listening on 0.0.0.0:0 (device: ) failed:
 *         [enum_route] [TCP] Operation not supported on transport endpoint
 *
 * Sem enxergar interface nenhuma, ela fica só com os soquetes "qualquer
 * endereço" -- `0.0.0.0` e `[::]` -- e é a partir deles que tenta falar com o
 * tracker. Daí saem os dois erros do registro, cada um por um motivo:
 *
 *     [[::]:6881]      Network is unreachable     (sair por IPv6 para um
 *                                                  tracker que só tem IPv4)
 *     [0.0.0.0:6881]   unspecified system error   (amarrar a conexão de saída
 *                                                  na porta de escuta)
 *
 * O Android, porém, sabe perfeitamente qual é a rede ativa e quais endereços
 * ela tem -- é só perguntar pelo ConnectivityManager, do lado Java, onde não há
 * NETLINK nenhum envolvido. É o que este arquivo faz: entrega os endereços de
 * verdade para a libtorrent escutar (e falar) por eles.
 */
object Rede {

    class Ativa(val interfaceDeRede: String, val enderecos: List<String>, val temIpv6: Boolean)

    private var ultima: Ativa? = null

    fun ultimaConhecida(): Ativa? = ultima

    /** A rede que o sistema está usando agora. */
    fun ativa(contexto: Context): Ativa? {
        val cm = contexto.getSystemService(ConnectivityManager::class.java) ?: return null
        val rede: Network = cm.activeNetwork ?: return null
        val propriedades = cm.getLinkProperties(rede) ?: return null

        var temIpv6 = false
        val enderecos = mutableListOf<String>()
        for (endereco in propriedades.linkAddresses) {
            val ip = endereco.address
            // Loopback não sai do aparelho; link-local (fe80::) só fala com o
            // vizinho de cabo -- nenhum dos dois alcança um tracker.
            if (ip.isLoopbackAddress || ip.isLinkLocalAddress || ip.isAnyLocalAddress) continue
            val texto = ip.hostAddress?.substringBefore('%') ?: continue
            when (ip) {
                is Inet4Address -> enderecos.add(texto)
                is Inet6Address -> {
                    temIpv6 = true
                    enderecos.add(texto)
                }
                else -> {}
            }
        }

        if (enderecos.isEmpty()) return null
        val nova = Ativa(propriedades.interfaceName ?: "", enderecos, temIpv6)
        ultima = nova
        return nova
    }

    /**
     * O valor de `listen_interfaces` da libtorrent: "ip:porta", IPv6 entre
     * colchetes, separados por vírgula.
     *
     * Sem rede conhecida, voltamos ao "qualquer endereço" -- que é o que a
     * libtorrent faria sozinha. É pior, mas é melhor do que não escutar nada:
     * assim que a rede aparecer, `Motor` reaplica com o endereço de verdade.
     */
    fun paraLibtorrent(contexto: Context, porta: Int): String {
        val rede = ativa(contexto) ?: return "0.0.0.0:$porta,[::]:$porta"
        return rede.enderecos.joinToString(",") { ip ->
            if (ip.contains(':')) "[$ip]:$porta" else "$ip:$porta"
        }
    }

    /** Avisa quando a rede troca (Wi-Fi ↔ dados, ou o IP muda). */
    fun observar(contexto: Context, aoMudar: () -> Unit): ConnectivityManager.NetworkCallback? {
        val cm = contexto.getSystemService(ConnectivityManager::class.java) ?: return null
        val ouvinte = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(rede: Network) = aoMudar()
            override fun onLost(rede: Network) = aoMudar()
            override fun onLinkPropertiesChanged(rede: Network, p: android.net.LinkProperties) = aoMudar()
        }
        return try {
            cm.registerDefaultNetworkCallback(ouvinte)
            ouvinte
        } catch (e: Exception) {
            Diagnostico.anotar("rede", "não consegui observar a rede: ${e.message}")
            null
        }
    }

    fun esquecer(contexto: Context, ouvinte: ConnectivityManager.NetworkCallback?) {
        if (ouvinte == null) return
        try {
            contexto.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(ouvinte)
        } catch (e: Exception) {
            // já tinha saído
        }
    }

    /** Para o arquivo de diagnóstico. */
    fun relatorio(contexto: Context): JSONObject {
        val rede = ativa(contexto)
        val cm = contexto.getSystemService(ConnectivityManager::class.java)
        val capacidades = try {
            cm?.getNetworkCapabilities(cm.activeNetwork)
        } catch (e: Exception) {
            null
        }
        return JSONObject()
            .put("interface", rede?.interfaceDeRede ?: JSONObject.NULL)
            .put("enderecos", JSONArray(rede?.enderecos ?: emptyList<String>()))
            .put("temIpv6", rede?.temIpv6 ?: false)
            .put(
                "tipo",
                when {
                    capacidades == null -> "desconhecido"
                    capacidades.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wi-fi"
                    capacidades.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "dados móveis"
                    capacidades.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "cabo"
                    capacidades.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
                    else -> "outro"
                }
            )
            .put("naoMedida", capacidades?.hasCapacity() ?: JSONObject.NULL)
    }

    private fun NetworkCapabilities.hasCapacity(): Boolean =
        hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
}
