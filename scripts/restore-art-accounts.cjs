// a-rt.com 에서 삭제 표식만 찍힌 계정 3개(표식만 찍힌 3개)를 되살리고 서버에 다시 올리도록 예약한다.
// 사용: 앱을 끈 상태에서  node scratchpad/restore-art.cjs "C:\Users\canno\AppData\Roaming\SAMBA Browser\data.db"
const initSqlJs = require('sql.js')
const fs = require('fs')
const path = process.argv[2]
fs.copyFileSync(path, `${path}.bak-${Date.now()}`)
initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync(path))
  const q = (sql) => {
    const r = db.exec(sql)
    return r.length
      ? r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]])))
      : []
  }
  const now = Date.now()
  const rows = q(
    "select a.id, a.username, a.workspace_id from accounts a join sites s on s.id=a.site_id where s.host='a-rt.com' and a.deleted_at is not null"
  )
  console.table(rows)
  for (const r of rows) {
    db.run('update accounts set deleted_at=null, updated_at=? where id=?', [now, r.id])
    db.run(
      "insert into sync_outbox(\"table\", row_id, op, payload, created_at, workspace_id) values('accounts', ?, 'upsert', null, ?, ?)",
      [String(r.id), now, r.workspace_id]
    )
  }
  console.table(
    q(
      "select a.id, s.host, a.username, a.deleted_at from accounts a join sites s on s.id=a.site_id where s.host='a-rt.com' order by a.id"
    )
  )
  fs.writeFileSync(path, Buffer.from(db.export()))
  console.log('복구 완료:', rows.length, '개')
})
