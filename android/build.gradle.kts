/*
 * As versoes do plugin do Android e do Kotlin andam juntas: o AGP traz uma
 * kotlin-stdlib consigo, e o compilador recusa uma stdlib mais nova do que ele.
 */
plugins {
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.10" apply false
}
