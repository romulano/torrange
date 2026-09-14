plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * O APK sai com a mesma versao do aplicativo de desktop -- e o mesmo produto,
 * falando a mesma API, com a mesma interface.
 */
val versaoDoApp = "1.1.0"

android {
    namespace = "com.torrange.app"
    compileSdk = 36

    // O 36 nao e capricho: o libvlc-all 3.7.6 recusa ser compilado contra
    // menos que isso. O targetSdk continua em 35 de proposito -- compilar
    // contra uma API nova e aceitar o comportamento novo dela em tempo de
    // execucao sao duas decisoes diferentes.
    //
    // A versao das build-tools e explicita porque, sem ela, o plugin escolhe a
    // dele e tenta BAIXAR o SDK no meio do build -- que e justamente o que a
    // imagem do Docker existe para evitar.
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.torrange.app"
        minSdk = 26
        targetSdk = 35
        // Sobe a cada APK publicado, mesmo sem mudar o versionName: e o
        // numero que o Android usa para saber o que e atualizacao.
        // 10101: conserta a lixeira (a WebView engolia o confirm) e o download
        // que nao comecava (o torrent entrava pausado).
        versionCode = 10101
        versionName = versaoDoApp

        ndk {
            // libVLC e libtorrent4j trazem binario para quatro arquiteturas.
            // As duas de ARM cobrem telefone e TV box; as de x86 so existem
            // para emulador e dobrariam o tamanho do APK.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    signingConfigs {
        create("torrange") {
            // Chave de assinatura propria, gerada pelo build.sh-android e
            // guardada fora do git. Sem ela o Android recusa instalar o APK.
            val loja = file(System.getenv("TORRANGE_KEYSTORE") ?: "${rootDir}/chave/torrange.jks")
            if (loja.exists()) {
                storeFile = loja
                storePassword = System.getenv("TORRANGE_KEYSTORE_SENHA") ?: "torrange"
                keyAlias = System.getenv("TORRANGE_KEY_ALIAS") ?: "torrange"
                keyPassword = System.getenv("TORRANGE_KEY_SENHA") ?: "torrange"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("torrange")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        // O BuildConfig nao vem de graca no AGP 8. Ele e quem diz ao codigo a
        // versao do aplicativo, que aparece na tela Sobre, no diagnostico e no
        // user-agent que a libtorrent anuncia ao tracker.
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            // O libVLC precisa das .so no disco (ele carrega plugins por
            // caminho), entao nada de comprimir dentro do APK.
            useLegacyPackaging = true
        }
        resources {
            excludes += setOf("META-INF/*.kotlin_module", "META-INF/DEPENDENCIES")
        }
    }

    lint {
        abortOnError = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // O lugar do qBittorrent: a mesma libtorrent, embutida no processo.
    implementation("org.libtorrent4j:libtorrent4j:2.1.0-39")
    implementation("org.libtorrent4j:libtorrent4j-android-arm64:2.1.0-39")
    implementation("org.libtorrent4j:libtorrent4j-android-arm:2.1.0-39")

    // O lugar do mpv: MKV, H.265, AC3/DTS/TrueHD, faixas e legendas embutidas.
    implementation("org.videolan.android:libvlc-all:3.7.6")
}
