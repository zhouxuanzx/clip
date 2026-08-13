package cool.clip.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [CollectionEntity::class, ItemEntity::class, PeerEntity::class],
    version = 1,
    exportSchema = true
)
abstract class ClipDatabase : RoomDatabase() {
    abstract fun dao(): ClipDao

    companion object {
        @Volatile
        private var instance: ClipDatabase? = null

        fun get(context: Context): ClipDatabase =
            instance ?: synchronized(this) {
                instance ?: Room
                    .databaseBuilder(context.applicationContext, ClipDatabase::class.java, "clip.db")
                    .build()
                    .also { instance = it }
            }
    }
}
