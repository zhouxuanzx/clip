package cool.clip.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.SolidColor
import coil.compose.AsyncImage
import cool.clip.data.SaveBlock

/**
 * 块编辑器（参考华为备忘录 / OPPO 便签）：
 * 一条笔记由「文本块 / 图片块」按顺序拼成，文字与图片可任意穿插。
 *
 * 关键交互：点「插入图片」时，在当前光标处把正在编辑的文本块劈成两段
 * [前文][图片][后文]，光标自动落到「后文」，可接着打字 —— 实现真正的图文穿插。
 * 文本框无边框、随内容撑高，整页连续滚动，像一张便签，不再是格子。
 */
private sealed interface EditBlock {
    val key: Long
    data class Text(val tf: TextFieldValue, override val key: Long) : EditBlock
    data class Image(val name: String?, val uri: Uri?, override val key: Long) : EditBlock
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScreen(
    initialBlocks: List<SaveBlock>,
    onSave: (List<SaveBlock>) -> Unit,
    onCancel: () -> Unit
) {
    val context = LocalContext.current
    val blocks = remember {
        var seed = 1L
        mutableStateListOf<EditBlock>().apply {
            if (initialBlocks.isEmpty()) {
                add(EditBlock.Text(TextFieldValue(""), seed++))
            } else {
                initialBlocks.forEach { b ->
                    when (b) {
                        is SaveBlock.Text -> add(EditBlock.Text(TextFieldValue(b.text), seed++))
                        is SaveBlock.Image -> add(EditBlock.Image(b.name, b.uri, seed++))
                    }
                }
            }
        }
    }

    var keySeed by remember { mutableLongStateOf(1_000_000L) }
    fun nextKey(): Long = ++keySeed

    var focusedKey by remember { mutableStateOf<Long?>(null) }
    var pendingFocusKey by remember { mutableStateOf<Long?>(null) }
    var replaceKey by remember { mutableStateOf<Long?>(null) }

    val focusRequesters = remember { mutableMapOf<Long, FocusRequester>() }

    LaunchedEffect(pendingFocusKey) {
        pendingFocusKey?.let { k ->
            focusRequesters[k]?.requestFocus()
            pendingFocusKey = null
        }
    }

    fun focusIndex(): Int {
        val k = focusedKey ?: return -1
        return blocks.indexOfFirst { it.key == k }
    }

    fun insertImagesAtCursor(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val idx = focusIndex()
        val cur = if (idx in blocks.indices) blocks[idx] else null
        if (cur !is EditBlock.Text) {
            // 没有可劈开的文本块：直接追加到末尾
            uris.forEach { blocks.add(EditBlock.Image(null, it, nextKey())) }
            return
        }
        val pos = cur.tf.selection.start.coerceIn(0, cur.tf.text.length)
        val full = cur.tf.text
        val before = full.substring(0, pos)
        val after = full.substring(pos)
        val afterKey = nextKey()
        val insertion = buildList {
            add(EditBlock.Text(TextFieldValue(before), cur.key))
            uris.forEach { add(EditBlock.Image(null, it, nextKey())) }
            add(EditBlock.Text(TextFieldValue(after), afterKey))
        }
        blocks.removeAt(idx)
        blocks.addAll(idx, insertion)
        pendingFocusKey = afterKey
    }

    fun insertTextAfterFocused() {
        val idx = focusIndex()
        val at = if (idx < 0) blocks.size else idx + 1
        val newKey = nextKey()
        blocks.add(at, EditBlock.Text(TextFieldValue(""), newKey))
        pendingFocusKey = newKey
    }

    fun removeAt(index: Int) {
        blocks.removeAt(index)
        if (blocks.isEmpty()) blocks.add(EditBlock.Text(TextFieldValue(""), nextKey()))
        if (focusedKey == blocks.getOrNull(index)?.key) focusedKey = null
    }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia()
    ) { picked: List<Uri> ->
        if (picked.isEmpty()) { replaceKey = null; return@rememberLauncherForActivityResult }
        val key = replaceKey
        if (key != null) {
            val idx = blocks.indexOfFirst { it.key == key }
            if (idx >= 0) blocks[idx] = (blocks[idx] as EditBlock.Image).copy(uri = picked.first(), name = null)
            replaceKey = null
        } else {
            insertImagesAtCursor(picked)
        }
    }

    fun launchPicker(replace: Long? = null) {
        replaceKey = replace
        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    val canSave = blocks.any {
        when (it) {
            is EditBlock.Text -> it.tf.text.isNotBlank()
            is EditBlock.Image -> it.uri != null || it.name != null
        }
    }

    val isNew = blocks.size == 1 && blocks[0] is EditBlock.Text && blocks[0].let { (it as EditBlock.Text).tf.text.isEmpty() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (isNew) "新建" else "编辑") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(onClick = { launchPicker() }) {
                        Icon(Icons.Filled.Image, contentDescription = "插入图片")
                    }
                    IconButton(onClick = { insertTextAfterFocused() }) {
                        Icon(Icons.Filled.Add, contentDescription = "插入文字块")
                    }
                    IconButton(onClick = {
                        val saved = blocks.mapNotNull {
                            when (it) {
                                is EditBlock.Text -> if (it.tf.text.isBlank()) null
                                else SaveBlock.Text(it.tf.text)
                                is EditBlock.Image -> SaveBlock.Image(it.name, it.uri)
                            }
                        }
                        onSave(saved)
                    }, enabled = canSave) {
                        Icon(Icons.Filled.Check, contentDescription = "保存")
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
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            blocks.forEachIndexed { index, block ->
                key(block.key) {
                    when (block) {
                        is EditBlock.Text -> {
                            val requester = remember(block.key) {
                                focusRequesters.getOrPut(block.key) { FocusRequester() }
                            }
                            BasicTextField(
                                value = block.tf,
                                onValueChange = { blocks[index] = block.copy(tf = it) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .focusRequester(requester)
                                    .onFocusChanged { if (it.isFocused) focusedKey = block.key },
                                textStyle = MaterialTheme.typography.bodyLarge.copy(
                                    color = MaterialTheme.colorScheme.onSurface,
                                    lineHeight = 22.sp
                                ),
                                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                                decorationBox = { innerTextField ->
                                    if (block.tf.text.isEmpty()) {
                                        Text(
                                            "输入内容…",
                                            style = MaterialTheme.typography.bodyLarge,
                                            color = MaterialTheme.colorScheme.outline
                                        )
                                    }
                                    innerTextField()
                                }
                            )
                        }
                        is EditBlock.Image -> {
                            var menuExpanded by remember(block.key) { mutableStateOf(false) }
                            Box(Modifier.fillMaxWidth()) {
                                AsyncImage(
                                    model = block.uri ?: block.name,
                                    contentDescription = null,
                                    contentScale = ContentScale.FillWidth,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(MaterialTheme.colorScheme.surfaceVariant)
                                        .pointerInput(block.key) {
                                            detectTapGestures(
                                                onTap = { launchPicker(replace = block.key) },
                                                onLongPress = { menuExpanded = true }
                                            )
                                        }
                                )
                                DropdownMenu(
                                    expanded = menuExpanded,
                                    onDismissRequest = { menuExpanded = false }
                                ) {
                                    DropdownMenuItem(
                                        text = { Text("删除") },
                                        onClick = { menuExpanded = false; removeAt(index) }
                                    )
                                    DropdownMenuItem(
                                        text = { Text("下载到相册") },
                                        onClick = { menuExpanded = false; saveImageToGallery(context, block.uri) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
