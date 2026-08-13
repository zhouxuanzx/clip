package cool.clip

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cool.clip.ui.ClipTheme
import cool.clip.ui.ClipViewModel
import cool.clip.ui.HomeScreen
import cool.clip.ui.SettingsScreen
import cool.clip.ui.TransfersScreen

class MainActivity : ComponentActivity() {
    private val vm: ClipViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            ClipTheme {
                val context = LocalContext.current
                var showSettings by rememberSaveable { mutableStateOf(false) }
                var tab by rememberSaveable { mutableStateOf("home") }

                LaunchedEffect(Unit) {
                    vm.notices.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }
                }

                val message by vm.message.collectAsStateWithLifecycle()
                LaunchedEffect(message) {
                    message?.let {
                        Toast.makeText(context, it, Toast.LENGTH_SHORT).show()
                        vm.consumeMessage()
                    }
                }

                if (showSettings) {
                    SettingsScreen(vm, onBack = { showSettings = false })
                } else {
                    Scaffold(
                        bottomBar = {
                            NavigationBar {
                                NavigationBarItem(
                                    selected = tab == "home",
                                    onClick = { tab = "home" },
                                    icon = { Icon(Icons.Default.Home, contentDescription = null) },
                                    label = { Text("剪贴板") }
                                )
                                NavigationBarItem(
                                    selected = tab == "transfers",
                                    onClick = { tab = "transfers" },
                                    icon = { Icon(Icons.Default.Sync, contentDescription = null) },
                                    label = { Text("传输") }
                                )
                            }
                        }
                    ) { outerPadding ->
                        when (tab) {
                            "home" -> HomeScreen(
                                vm,
                                onOpenSettings = { showSettings = true },
                                modifier = Modifier.padding(outerPadding)
                            )
                            "transfers" -> TransfersScreen(vm, modifier = Modifier.padding(outerPadding))
                        }
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // 开了后台常驻就交给前台服务管，否则只在界面可见时连着
        if (!ClipApp.from(this).repo.prefs.keepConnected) vm.connect()
    }

    override fun onStop() {
        super.onStop()
        if (!ClipApp.from(this).repo.prefs.keepConnected) vm.disconnect()
    }
}
