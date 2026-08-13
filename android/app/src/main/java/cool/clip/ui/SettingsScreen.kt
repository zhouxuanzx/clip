package cool.clip.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import cool.clip.sync.SyncService
import cool.clip.sync.SyncState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(vm: ClipViewModel, onBack: () -> Unit) {
    val context = LocalContext.current
    val syncState by vm.syncState.collectAsStateWithLifecycle()
    val peers by vm.peers.collectAsStateWithLifecycle()

    var nameDraft by remember { mutableStateOf(vm.deviceName) }
    var keepConnected by remember { mutableStateOf(vm.keepConnected) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents != null) vm.pairFromQr(contents)
    }

    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 拒绝也不影响连接，只是看不到常驻通知 */ }

    fun startScan() {
        scanner.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("对准电脑上的配对二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(false)
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("连接状态", style = MaterialTheme.typography.titleSmall)
                    Text(
                        when (val state = syncState) {
                            is SyncState.Connected -> "已连上「${state.peerName}」"
                            is SyncState.Connecting -> "正在连接…"
                            is SyncState.Failed -> state.reason
                            SyncState.Idle -> "未连接"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { vm.connect() },
                            enabled = peers.isNotEmpty() && syncState !is SyncState.Connected
                        ) { Text("连接") }
                        OutlinedButton(
                            onClick = { vm.disconnect() },
                            enabled = syncState !is SyncState.Idle
                        ) { Text("断开") }
                    }
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("配对的电脑", style = MaterialTheme.typography.titleSmall)
                    if (peers.isEmpty()) {
                        Text(
                            "还没有配对。电脑端打开「手机同步」→「配对新手机」显示二维码，然后扫它。",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        peers.forEach { peer ->
                            Row(
                                Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(peer.name)
                                    Text(
                                        "${peer.host}:${peer.port}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                TextButton(onClick = { vm.forgetPeer(peer) }) { Text("解除") }
                            }
                        }
                    }
                    Button(onClick = { startScan() }) { Text("扫码配对") }
                    Text(
                        "电脑换了 IP 或者重装过，重新扫一次码即可。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("后台保持连接")
                            Text(
                                "常驻一个低优先级通知，息屏时也能收到电脑推来的内容",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = keepConnected,
                            onCheckedChange = { enabled ->
                                keepConnected = enabled
                                if (enabled) {
                                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                    SyncService.start(context)
                                } else {
                                    SyncService.stop(context)
                                }
                            }
                        )
                    }
                }
            }

            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("本机名称", style = MaterialTheme.typography.titleSmall)
                    OutlinedTextField(
                        value = nameDraft,
                        onValueChange = { nameDraft = it },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Text(
                        "电脑端的设备列表里显示的就是这个名字，改完下次连接生效。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    TextButton(onClick = { vm.setDeviceName(nameDraft) }) { Text("保存") }
                }
            }
        }
    }
}
