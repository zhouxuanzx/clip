package cool.clip.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import cool.clip.data.ItemEntity
import cool.clip.sync.SyncState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: ClipViewModel, onOpenSettings: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val collections by vm.collections.collectAsStateWithLifecycle()
    val active by vm.activeCollection.collectAsStateWithLifecycle()
    val items by vm.items.collectAsStateWithLifecycle()
    val syncState by vm.syncState.collectAsStateWithLifecycle()

    var adding by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(active?.name ?: "Clip") },
                actions = {
                    ConnectionDot(syncState)
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "设置")
                    }
                }
            )
        },
        floatingActionButton = {
            if (active != null) {
                FloatingActionButton(onClick = { adding = true }) {
                    Icon(Icons.Default.Add, contentDescription = "添加")
                }
            }
        }
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (collections.isNotEmpty()) {
                Row(
                    Modifier
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    collections.forEach { collection ->
                        FilterChip(
                            selected = collection.id == active?.id,
                            onClick = { vm.selectCollection(collection.id) },
                            label = { Text(collection.name) }
                        )
                    }
                }
            }

            if (collections.isEmpty()) {
                EmptyHint(
                    "还没有任何分类。\n先在电脑上打开「手机同步」显示二维码，用设置页的扫码配对。",
                    onOpenSettings
                )
            } else if (items.isEmpty()) {
                EmptyHint("这个分类还是空的", null)
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(items, key = { it.id }) { item ->
                        ItemCard(
                            item = item,
                            isTodo = active?.kind == "todo",
                            imagePath = { vm.imageFile(item) },
                            onCopy = { copyToClipboard(context, item, vm) },
                            onToggleDone = { vm.toggleDone(item) },
                            onPush = { vm.pushItem(item) },
                            onDelete = { vm.deleteItem(item) }
                        )
                    }
                }
            }
        }
    }

    if (adding) {
        AddTextDialog(
            onDismiss = { adding = false },
            onConfirm = {
                vm.addText(it)
                adding = false
            }
        )
    }
}

@Composable
private fun ConnectionDot(state: SyncState) {
    val color = when (state) {
        is SyncState.Connected -> Color(0xFF34C759)
        is SyncState.Connecting -> Color(0xFFFFB020)
        else -> MaterialTheme.colorScheme.outlineVariant
    }
    Box(
        Modifier
            .padding(end = 4.dp)
            .size(10.dp)
            .background(color, CircleShape)
    )
}

@Composable
private fun EmptyHint(text: String, onOpenSettings: (() -> Unit)?) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(32.dp)
            )
            if (onOpenSettings != null) {
                TextButton(onClick = onOpenSettings) { Text("去扫码配对") }
            }
        }
    }
}

@Composable
private fun ItemCard(
    item: ItemEntity,
    isTodo: Boolean,
    imagePath: () -> java.io.File,
    onCopy: () -> Unit,
    onToggleDone: () -> Unit,
    onPush: () -> Unit,
    onDelete: () -> Unit
) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onCopy)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                if (isTodo) {
                    Checkbox(checked = item.done, onCheckedChange = { onToggleDone() })
                }
                if (item.type == "image") {
                    AsyncImage(
                        model = imagePath(),
                        contentDescription = null,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp)
                    )
                } else {
                    Text(
                        item.content,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            Row(
                Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    formatTime(item.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f)
                )
                IconButton(onClick = onPush, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.Send, contentDescription = "推送到电脑", Modifier.size(18.dp))
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Default.Delete, contentDescription = "删除", Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun AddTextDialog(onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("添加一条") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth().height(160.dp),
                placeholder = { Text("输入内容") }
            )
        },
        confirmButton = {
            TextButton(
                enabled = text.isNotBlank(),
                onClick = { onConfirm(text) }
            ) { Text("添加") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

private fun copyToClipboard(context: Context, item: ItemEntity, vm: ClipViewModel) {
    if (item.type != "text") {
        vm.showMessage("图片请长按预览后自行保存")
        return
    }
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    manager.setPrimaryClip(ClipData.newPlainText("clip", item.content))
    // 安卓 13 起系统自己会弹"已复制"，再弹一次就重复了
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
    }
}

private val timeFormat = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

private fun formatTime(timestamp: Long): String = timeFormat.format(Date(timestamp))
