package cool.clip.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cool.clip.sync.FileTransfer
import cool.clip.sync.TransferState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransfersScreen(vm: ClipViewModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val transfers by vm.transfers.collectAsStateWithLifecycle()

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentMultiple()) { result ->
        val uris = result ?: emptyList()
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        uris.forEach { uri ->
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            }
        }
        vm.sendFiles(uris)
    }

    val finishedCount = transfers.count { it.state == TransferState.DONE || it.state == TransferState.FAILED || it.state == TransferState.CANCELED }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("传输") },
                actions = {
                    TextButton(onClick = { picker.launch(arrayOf("*/*")) }) {
                        Text("选择文件")
                    }
                    if (finishedCount > 0) {
                        TextButton(onClick = { vm.clearTransfers() }) { Text("清空已完成") }
                    }
                }
            )
        }
    ) { padding ->
        if (transfers.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "把文件从手机发到电脑，或接收电脑发来的文件。\n电脑端打开「传输」页 → 选择文件，即可发到这部手机。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(32.dp)
                    )
                    TextButton(onClick = { picker.launch(arrayOf("*/*")) }) { Text("选择文件发送") }
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(transfers, key = { it.key }) { transfer ->
                    TransferCard(
                        transfer = transfer,
                        onCancel = { vm.cancelTransfer(transfer.key) },
                        onReveal = { vm.revealTransfer(transfer) }
                    )
                }
            }
        }
    }
}

@Composable
private fun TransferCard(
    transfer: FileTransfer,
    onCancel: () -> Unit,
    onReveal: () -> Unit
) {
    val active = transfer.state == TransferState.ACTIVE || transfer.state == TransferState.WAITING
    val pct = if (transfer.size > 0) (transfer.transferred * 100 / transfer.size).toFloat() / 100f else 0f

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (transfer.direction == "send") Icons.Default.ArrowUpward else Icons.Default.ArrowDownward,
                    contentDescription = null,
                    modifier = Modifier.padding(end = 6.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(transfer.name, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                Text(
                    stateLabel(transfer.state),
                    style = MaterialTheme.typography.labelSmall,
                    color = stateColor(transfer.state)
                )
            }

            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "${transfer.deviceName} · ${formatTime(transfer.startedAt)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f)
                )
                val sizeText = if (transfer.size > 0) {
                    "${formatSize(transfer.transferred)} / ${formatSize(transfer.size)}"
                } else {
                    formatSize(transfer.transferred)
                }
                Text(sizeText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            if (transfer.error.isNotBlank()) {
                Text(transfer.error, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }

            if (active) {
                LinearProgressIndicator(progress = { pct }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
            }

            Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                if (active) {
                    TextButton(onClick = onCancel) { Text("取消") }
                }
                if (transfer.direction == "receive" && transfer.state == TransferState.DONE) {
                    TextButton(onClick = onReveal) { Text("打开文件") }
                }
            }
        }
    }
}

private fun stateLabel(state: TransferState): String = when (state) {
    TransferState.WAITING -> "排队中"
    TransferState.ACTIVE -> "传输中"
    TransferState.DONE -> "完成"
    TransferState.FAILED -> "失败"
    TransferState.CANCELED -> "已取消"
}

@Composable
private fun stateColor(state: TransferState): androidx.compose.ui.graphics.Color {
    return when (state) {
        TransferState.DONE -> MaterialTheme.colorScheme.primary
        TransferState.FAILED, TransferState.CANCELED -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

private fun formatSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    if (bytes < 1024 * 1024) return "${bytes / 1024} KB"
    return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
}

private val timeFormat = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
private fun formatTime(timestamp: Long): String = timeFormat.format(Date(timestamp))
