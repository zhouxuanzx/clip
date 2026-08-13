package cool.clip.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ClipDao {

    // ── 分类 ──────────────────────────────────────────────

    @Query("SELECT * FROM collections WHERE deleted = 0 ORDER BY sortOrder ASC")
    fun observeCollections(): Flow<List<CollectionEntity>>

    @Query("SELECT * FROM collections WHERE deleted = 0 ORDER BY sortOrder ASC")
    suspend fun listCollections(): List<CollectionEntity>

    @Query("SELECT * FROM collections WHERE id = :id")
    suspend fun findCollection(id: String): CollectionEntity?

    @Query("SELECT COALESCE(MAX(sortOrder), -1) FROM collections")
    suspend fun maxCollectionOrder(): Int

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCollection(collection: CollectionEntity)

    @Query("SELECT syncMode FROM collections WHERE id = :id")
    suspend fun collectionSyncMode(id: String): String?

    // ── 条目 ──────────────────────────────────────────────

    @Query(
        """SELECT * FROM items
             WHERE collectionId = :collectionId AND deleted = 0
             ORDER BY pinned DESC, createdAt DESC"""
    )
    fun observeItems(collectionId: String): Flow<List<ItemEntity>>

    @Query("SELECT * FROM items WHERE id = :id")
    suspend fun findItem(id: String): ItemEntity?

    @Query("SELECT * FROM items WHERE id IN (:ids) AND deleted = 0")
    suspend fun findItems(ids: List<String>): List<ItemEntity>

    @Query("SELECT * FROM items WHERE type = 'image' AND deleted = 0 AND hash IN (:hashes)")
    suspend fun findImageItemsByHash(hashes: List<String>): List<ItemEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertItem(item: ItemEntity)

    @Update
    suspend fun updateItem(item: ItemEntity)

    /** 软删除：留墓碑才能把删除同步给对端 */
    @Query("UPDATE items SET deleted = 1, content = '', updatedAt = :now WHERE id IN (:ids)")
    suspend fun softDeleteItems(ids: List<String>, now: Long)

    /** 同一分类内按 hash 找已有条目，手动添加时用来去重 */
    @Query("SELECT * FROM items WHERE collectionId = :collectionId AND hash = :hash AND deleted = 0 LIMIT 1")
    suspend fun findByHash(collectionId: String, hash: String): ItemEntity?

    // ── 自动同步的增量 ────────────────────────────────────

    @Query(
        """SELECT i.* FROM items i
             JOIN collections c ON c.id = i.collectionId
            WHERE c.syncMode = 'auto' AND i.updatedAt > :since
            ORDER BY i.updatedAt ASC"""
    )
    suspend fun autoChangedItems(since: Long): List<ItemEntity>

    @Query("SELECT * FROM collections WHERE syncMode = 'auto' AND updatedAt > :since")
    suspend fun autoChangedCollections(since: Long): List<CollectionEntity>

    @Query("SELECT * FROM collections WHERE id IN (:ids)")
    suspend fun collectionsByIds(ids: List<String>): List<CollectionEntity>

    /** 清理保留期之外的墓碑，顺带回收图片 */
    @Query("SELECT content FROM items WHERE deleted = 1 AND updatedAt < :before AND type = 'image'")
    suspend fun tombstoneImages(before: Long): List<String>

    @Query("DELETE FROM items WHERE deleted = 1 AND updatedAt < :before")
    suspend fun purgeTombstones(before: Long)

    // ── 配对的桌面端 ──────────────────────────────────────

    @Query("SELECT * FROM peers ORDER BY pairedAt ASC")
    fun observePeers(): Flow<List<PeerEntity>>

    @Query("SELECT * FROM peers ORDER BY pairedAt ASC LIMIT 1")
    suspend fun primaryPeer(): PeerEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPeer(peer: PeerEntity)

    @Query("UPDATE peers SET lastSyncAt = :at WHERE id = :id AND lastSyncAt < :at")
    suspend fun advanceLastSync(id: String, at: Long)

    @Query("UPDATE peers SET host = :host, port = :port WHERE id = :id")
    suspend fun updatePeerAddress(id: String, host: String, port: Int)

    @Query("DELETE FROM peers WHERE id = :id")
    suspend fun deletePeer(id: String)
}
