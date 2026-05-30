export default [
  { id: 'sql-01-second-highest-per-dept', lang: 'sql',
    prompt: `SQLite。表 emp(id INTEGER, name TEXT, dept TEXT, salary INTEGER) 存放员工。要求：对每个部门 dept,找出该部门「第二高的薪资值」(按不同的薪资值排名,相同薪资算同一名次,即用 DENSE_RANK 语义;若某部门只有一个不同薪资值则该部门不出现在结果中)。输出列 (dept, salary),按 dept 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE emp(id INTEGER, name TEXT, dept TEXT, salary INTEGER); INSERT INTO emp VALUES (1,'Ann','eng',100),(2,'Bob','eng',100),(3,'Cay','eng',90),(4,'Dan','eng',80),(5,'Eve','sales',70),(6,'Foo','sales',70),(7,'Gid','sales',60),(8,'Hal','ops',50);", expect:[["eng",90],["sales",60]]}),
    canonical: `WITH r AS (SELECT dept, salary, DENSE_RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS dr FROM emp) SELECT dept, salary FROM r WHERE dr = 2 ORDER BY dept` },

  { id: 'sql-02-dedup-latest-event', lang: 'sql',
    prompt: `SQLite。表 events(user_id INTEGER, status TEXT, ts TEXT, id INTEGER),ts 是 'YYYY-MM-DD HH:MM' 文本时间戳,id 是自增主键。每个 user_id 有多条记录。要求:对每个 user_id 只保留「时间最新」的那一条;若同一 user_id 存在并列最新时间戳,则取其中 id 最大的一条。输出列 (user_id, status, ts),按 user_id 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE events(user_id INTEGER, status TEXT, ts TEXT, id INTEGER); INSERT INTO events VALUES (1,'a','2024-01-01 10:00',1),(1,'b','2024-01-03 09:00',2),(1,'c','2024-01-02 12:00',3),(2,'x','2024-02-01 00:00',4),(2,'y','2024-02-01 00:00',5),(3,'z','2024-01-15 08:30',6);", expect:[[1,"b","2024-01-03 09:00"],[2,"y","2024-02-01 00:00"],[3,"z","2024-01-15 08:30"]]}),
    canonical: `WITH r AS (SELECT user_id, status, ts, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts DESC, id DESC) AS rn FROM events) SELECT user_id, status, ts FROM r WHERE rn = 1 ORDER BY user_id` },

  { id: 'sql-03-running-balance', lang: 'sql',
    prompt: `SQLite。表 txn(acct TEXT, seq INTEGER, amount INTEGER) 是按账户的交易流水,seq 是该账户内的顺序号(从 1 递增),amount 可正可负。要求:按账户分组,沿 seq 升序计算「累计余额」(从该账户第一笔到当前笔的 amount 之和)。输出列 (acct, seq, amount, balance),先按 acct 升序、再按 seq 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE txn(acct TEXT, seq INTEGER, amount INTEGER); INSERT INTO txn VALUES ('A',1,100),('A',2,-30),('A',3,50),('A',4,-20),('B',1,200),('B',2,-200),('B',3,10);", expect:[["A",1,100,100],["A",2,-30,70],["A",3,50,120],["A",4,-20,100],["B",1,200,200],["B",2,-200,0],["B",3,10,10]]}),
    canonical: `SELECT acct, seq, amount, SUM(amount) OVER (PARTITION BY acct ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance FROM txn ORDER BY acct, seq` },

  { id: 'sql-04-consecutive-login-islands', lang: 'sql',
    prompt: `SQLite。表 logins(uid INTEGER, d TEXT),d 是 'YYYY-MM-DD' 日期文本,记录用户登录日(每个 uid+d 至多一条,无重复)。「连续登录段」指日期逐日相邻(相差正好 1 天)的最长连续区间。要求:对每个 uid 找出其「最长的连续登录段」,且仅当该段长度 ≥ 3 天时才输出(每个 uid 的最长段唯一,无需考虑并列)。输出列 (uid, start_d, end_d, streak),其中 start_d/end_d 为该段起止日期、streak 为该段天数;按 uid 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE logins(uid INTEGER, d TEXT); INSERT INTO logins VALUES (1,'2024-03-01'),(1,'2024-03-02'),(1,'2024-03-03'),(1,'2024-03-05'),(1,'2024-03-06'),(2,'2024-03-10'),(2,'2024-03-12'),(2,'2024-03-13'),(2,'2024-03-14');", expect:[[1,"2024-03-01","2024-03-03",3],[2,"2024-03-12","2024-03-14",3]]}),
    canonical: `WITH g AS (SELECT uid, d, date(d, '-' || (ROW_NUMBER() OVER (PARTITION BY uid ORDER BY d)) || ' days') AS grp FROM logins), s AS (SELECT uid, grp, MIN(d) AS start_d, MAX(d) AS end_d, COUNT(*) AS streak FROM g GROUP BY uid, grp) SELECT uid, start_d, end_d, streak FROM s WHERE streak = (SELECT MAX(streak) FROM s s2 WHERE s2.uid = s.uid) AND streak >= 3 ORDER BY uid` },

  { id: 'sql-05-org-chart-depth', lang: 'sql',
    prompt: `SQLite。表 org(id INTEGER, name TEXT, mgr INTEGER),mgr 是直属上级的 id,根节点(CEO)的 mgr 为 NULL。这是一棵层级树。要求:用递归 CTE 计算每个节点相对根节点的「层级深度」(根为 0,直属下级为 1,以此类推)。输出列 (id, name, depth),按 id 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE org(id INTEGER, name TEXT, mgr INTEGER); INSERT INTO org VALUES (1,'CEO',NULL),(2,'VP1',1),(3,'VP2',1),(4,'Dir1',2),(5,'Dir2',2),(6,'Eng1',4),(7,'Eng2',6);", expect:[[1,"CEO",0],[2,"VP1",1],[3,"VP2",1],[4,"Dir1",2],[5,"Dir2",2],[6,"Eng1",3],[7,"Eng2",4]]}),
    canonical: `WITH RECURSIVE t(id, name, depth) AS (SELECT id, name, 0 FROM org WHERE mgr IS NULL UNION ALL SELECT o.id, o.name, t.depth + 1 FROM org o JOIN t ON o.mgr = t.id) SELECT id, name, depth FROM t ORDER BY id` },

  { id: 'sql-06-month-pivot', lang: 'sql',
    prompt: `SQLite。表 sales(region TEXT, mon INTEGER, amt INTEGER),mon 取值 1/2/3 表示一季度的三个月,同一 region+mon 可能有多条记录。要求:把数据透视成每个 region 一行,分别汇总 1、2、3 月的销售额合计;某月无数据时该格为 0(不是 NULL)。输出列 (region, m1, m2, m3),按 region 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE sales(region TEXT, mon INTEGER, amt INTEGER); INSERT INTO sales VALUES ('N',1,10),('N',1,5),('N',2,20),('N',3,7),('S',1,8),('S',3,9),('S',3,1);", expect:[["N",15,20,7],["S",8,0,10]]}),
    canonical: `SELECT region, SUM(CASE WHEN mon=1 THEN amt ELSE 0 END) AS m1, SUM(CASE WHEN mon=2 THEN amt ELSE 0 END) AS m2, SUM(CASE WHEN mon=3 THEN amt ELSE 0 END) AS m3 FROM sales GROUP BY region ORDER BY region` },

  { id: 'sql-07-mom-growth-pct', lang: 'sql',
    prompt: `SQLite。表 rev(ym TEXT, amount INTEGER),ym 是 'YYYY-MM' 月份文本且唯一、可按字典序当时间序。要求:按月份升序计算「环比增长率百分比」= (本月 amount - 上月 amount) * 100.0 / 上月 amount,结果用 ROUND 保留 1 位小数。首月没有上月,不输出。输出列 (ym, amount, growth),按 ym 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE rev(ym TEXT, amount INTEGER); INSERT INTO rev VALUES ('2024-01',100),('2024-02',150),('2024-03',120),('2024-04',180);", expect:[["2024-02",150,50.0],["2024-03",120,-20.0],["2024-04",180,50.0]]}),
    canonical: `WITH r AS (SELECT ym, amount, LAG(amount) OVER (ORDER BY ym) AS prev FROM rev) SELECT ym, amount, ROUND((amount - prev) * 100.0 / prev, 1) AS growth FROM r WHERE prev IS NOT NULL ORDER BY ym` },

  { id: 'sql-08-sessionize-gap', lang: 'sql',
    prompt: `SQLite。表 clicks(uid INTEGER, ts INTEGER),ts 是整数时间戳(秒)。要求:对每个 uid 按 ts 升序做「会话切分」——相邻两次点击的时间间隔严格大于 300 秒(> 300,正好等于 300 仍算同一会话)就开启一个新会话;每个 uid 的第一条点击也开启一个会话。统计每个 uid 的会话数。输出列 (uid, sessions),按 uid 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE clicks(uid INTEGER, ts INTEGER); INSERT INTO clicks VALUES (1,0),(1,100),(1,400),(1,2000),(1,2100),(1,5000),(2,50),(2,90);", expect:[[1,3],[2,1]]}),
    canonical: `WITH ordered AS (SELECT uid, ts, LAG(ts) OVER (PARTITION BY uid ORDER BY ts) AS prev FROM clicks), marked AS (SELECT uid, CASE WHEN prev IS NULL OR ts - prev > 300 THEN 1 ELSE 0 END AS is_new FROM ordered) SELECT uid, SUM(is_new) AS sessions FROM marked GROUP BY uid ORDER BY uid` },

  { id: 'sql-09-top2-products-per-cat-revenue', lang: 'sql',
    prompt: `SQLite。两张表:prod(pid INTEGER, cat TEXT, name TEXT) 是产品,oi(pid INTEGER, qty INTEGER, price INTEGER) 是订单明细行。每个产品的「营收」= 其所有订单明细行的 qty*price 之和。要求:对每个分类 cat,取营收最高的前 2 个产品;若同分类内营收并列,则按产品 name 升序作为决胜(取靠前者)。输出列 (cat, name, total),先按 cat 升序、再按该分类内的营收名次升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE prod(pid INTEGER, cat TEXT, name TEXT); CREATE TABLE oi(pid INTEGER, qty INTEGER, price INTEGER); INSERT INTO prod VALUES (1,'A','p1'),(2,'A','p2'),(3,'A','p3'),(4,'B','p4'),(5,'B','p5'); INSERT INTO oi VALUES (1,2,10),(1,1,10),(2,5,4),(3,1,100),(3,1,50),(4,10,1),(5,3,3),(5,2,3);", expect:[["A","p3",150],["A","p1",30],["B","p5",15],["B","p4",10]]}),
    canonical: `WITH rev AS (SELECT p.cat, p.name, SUM(o.qty * o.price) AS total FROM prod p JOIN oi o ON o.pid = p.pid GROUP BY p.pid, p.cat, p.name), r AS (SELECT cat, name, total, ROW_NUMBER() OVER (PARTITION BY cat ORDER BY total DESC, name) AS rn FROM rev) SELECT cat, name, total FROM r WHERE rn <= 2 ORDER BY cat, rn` },

  { id: 'sql-10-median-per-group', lang: 'sql',
    prompt: `SQLite。表 m(grp TEXT, v INTEGER)。要求:计算每个 grp 的「中位数」median——把该组 v 升序排列,组内元素个数为奇数时取正中间那个值,为偶数时取中间两个值的平均;结果以浮点数返回(SQLite 中位数没有内置函数,需用窗口函数/排名自行实现)。输出列 (grp, median),按 grp 升序排列。只返回一条 SQL 查询,用 \`\`\`sql 包裹,不要解释。`,
    test: JSON.stringify({schema:"CREATE TABLE m(grp TEXT, v INTEGER); INSERT INTO m VALUES ('x',1),('x',2),('x',3),('x',4),('y',10),('y',20),('y',30),('z',5);", expect:[["x",2.5],["y",20.0],["z",5.0]]}),
    canonical: `WITH r AS (SELECT grp, v, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY v) AS rn, COUNT(*) OVER (PARTITION BY grp) AS cnt FROM m) SELECT grp, AVG(v * 1.0) AS median FROM r WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2) GROUP BY grp ORDER BY grp` }
];
