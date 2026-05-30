export default [
{ id: 'go-01-ordered-worker-pool', lang: 'go', prompt: `Go: 实现 func parallelMap(in []int, workers int, f func(int) int) []int。用恰好 workers 个 goroutine 组成的 worker pool 并发地对 in 的每个元素调用 f,结果切片必须与输入顺序一一对应(out[i] 对应 in[i]),不得因并发而乱序。workers 可能大于 len(in);in 可能为空。要求真并发(不是顺序循环)。提示:用 channel 分发带索引的任务,把结果写回各自的索引槽,用 channel 计数等待全部完成(不要用 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `r := parallelMap([]int{1, 2, 3, 4, 5}, 3, func(x int) int { return x * x })
if fmt.Sprint(r) != "[1 4 9 16 25]" {
	os.Exit(1)
}
r2 := parallelMap([]int{}, 2, func(x int) int { return x })
if fmt.Sprint(r2) != "[]" {
	os.Exit(1)
}
r3 := parallelMap([]int{10}, 8, func(x int) int { return x + 1 })
if fmt.Sprint(r3) != "[11]" {
	os.Exit(1)
}`, canonical: `func parallelMap(in []int, workers int, f func(int) int) []int {
	n := len(in)
	out := make([]int, n)
	type job struct{ idx, val int }
	jobs := make(chan job)
	done := make(chan int)
	for w := 0; w < workers; w++ {
		go func() {
			for j := range jobs {
				out[j.idx] = f(j.val)
				done <- 1
			}
		}()
	}
	go func() {
		for i, v := range in {
			jobs <- job{i, v}
		}
		close(jobs)
	}()
	for i := 0; i < n; i++ {
		<-done
	}
	return out
}` },

{ id: 'go-02-fanin-kway-merge', lang: 'go', prompt: `Go: 实现 func mergeSortedStreams(streams [][]int) []int。每个 streams[i] 是一个已升序排序的整数切片;为每个流启动一个 goroutine 通过各自的 channel 逐个发送元素(发完 close),主流程做 k 路归并(fan-in),输出一个完整升序排序的切片。必须从 channel 读取(不要直接遍历 streams 做归并),允许有重复值、空流、单流、空输入。提示:为每个流维护当前 head,每次选最小的 head 输出再从对应 channel 取下一个(只用 channel + goroutine,不要 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `r := mergeSortedStreams([][]int{{1, 4, 7}, {2, 5, 8}, {3, 6, 9}})
if fmt.Sprint(r) != "[1 2 3 4 5 6 7 8 9]" {
	os.Exit(1)
}
r2 := mergeSortedStreams([][]int{{1, 1, 2}, {1, 3}, {}})
if fmt.Sprint(r2) != "[1 1 1 2 3]" {
	os.Exit(1)
}
r3 := mergeSortedStreams([][]int{{5}})
if fmt.Sprint(r3) != "[5]" {
	os.Exit(1)
}
r4 := mergeSortedStreams([][]int{})
if fmt.Sprint(r4) != "[]" {
	os.Exit(1)
}`, canonical: `func mergeSortedStreams(streams [][]int) []int {
	k := len(streams)
	chans := make([]chan int, k)
	for i := range streams {
		chans[i] = make(chan int)
		go func(idx int) {
			for _, v := range streams[idx] {
				chans[idx] <- v
			}
			close(chans[idx])
		}(i)
	}
	heads := make([]int, k)
	open := make([]bool, k)
	live := 0
	for i := 0; i < k; i++ {
		v, ok := <-chans[i]
		if ok {
			heads[i] = v
			open[i] = true
			live++
		}
	}
	out := []int{}
	for live > 0 {
		best := -1
		for i := 0; i < k; i++ {
			if open[i] && (best == -1 || heads[i] < heads[best]) {
				best = i
			}
		}
		out = append(out, heads[best])
		v, ok := <-chans[best]
		if ok {
			heads[best] = v
		} else {
			open[best] = false
			live--
		}
	}
	return out
}` },

{ id: 'go-03-concurrent-bfs-count', lang: 'go', prompt: `Go: 实现 func countReachable(n int, neighbors func(int) []int, workers int) int,并发计算从节点 0 出发可达的不同节点总数(节点编号 0..n-1)。图可能有环、自环、重复边、孤立节点。用恰好 workers 个 goroutine 做并发的图遍历(动态产生新工作),必须正确去重(每个节点只计一次)且能在所有工作完成时正确终止(终止检测)。n 可能为 0。提示:用一个协调者 goroutine 独占 visited 状态与计数,worker 通过 channel 请求展开某节点、领取新发现的未访问邻居并回投为新任务;用一个 +1/-1 的 pending 计数 channel 检测全局完成(只用 channel + goroutine,不要 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `adj := map[int][]int{0: {1, 2}, 1: {3}, 2: {3, 4}, 3: {}, 4: {0}, 5: {6}, 6: {}}
nb := func(x int) []int { return adj[x] }
if countReachable(7, nb, 3) != 5 {
	os.Exit(1)
}
if countReachable(1, func(x int) []int { return []int{0} }, 4) != 1 {
	os.Exit(2)
}
chain := func(x int) []int {
	if x < 9 {
		return []int{x + 1}
	}
	return nil
}
if countReachable(10, chain, 2) != 10 {
	os.Exit(3)
}
full := func(x int) []int {
	r := []int{}
	for i := 0; i < 8; i++ {
		if i != x {
			r = append(r, i)
		}
	}
	return r
}
if countReachable(8, full, 5) != 8 {
	os.Exit(4)
}
if countReachable(5, func(x int) []int { return nil }, 3) != 1 {
	os.Exit(5)
}
if countReachable(0, func(x int) []int { return nil }, 3) != 0 {
	os.Exit(6)
}`, canonical: `func countReachable(n int, neighbors func(int) []int, workers int) int {
	if n == 0 {
		return 0
	}
	visited := make([]bool, n)
	type req struct {
		node  int
		reply chan []int
	}
	reqs := make(chan req)
	tasks := make(chan int, n+1)
	pending := make(chan int)
	finished := make(chan int)

	go func() {
		count := 1
		open := 0
		for {
			select {
			case r := <-reqs:
				var fresh []int
				for _, m := range neighbors(r.node) {
					if m >= 0 && m < n && !visited[m] {
						visited[m] = true
						count++
						fresh = append(fresh, m)
					}
				}
				r.reply <- fresh
			case d := <-pending:
				open += d
				if open == 0 {
					finished <- count
					return
				}
			}
		}
	}()

	for w := 0; w < workers; w++ {
		go func() {
			for node := range tasks {
				reply := make(chan []int)
				reqs <- req{node, reply}
				fresh := <-reply
				for _, m := range fresh {
					pending <- +1
					tasks <- m
				}
				pending <- -1
			}
		}()
	}

	visited[0] = true
	pending <- +1
	tasks <- 0
	total := <-finished
	close(tasks)
	return total
}` },

{ id: 'go-04-channel-barrier', lang: 'go', prompt: `Go: 实现 func barrierRounds(workers, rounds int, work func(worker, round int) int) []int。启动 workers 个 goroutine 跑 rounds 轮:在第 r 轮,每个 worker 调用 work(workerId, r) 得到一个值并贡献给本轮的累加和;所有 worker 必须在进入第 r+1 轮之前完成第 r 轮(屏障同步,barrier)。返回长度为 rounds 的切片,第 r 个元素是第 r 轮所有 worker 贡献值之和。必须用屏障保证轮次严格分隔。提示:每轮主流程从 worker 收集 workers 个贡献,全部到齐后再逐个放行 worker 进入下一轮(只用 channel + goroutine,不要 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `r := barrierRounds(3, 4, func(w, rd int) int { return (w + 1) * (rd + 1) })
if fmt.Sprint(r) != "[6 12 18 24]" {
	os.Exit(1)
}
r2 := barrierRounds(1, 3, func(w, rd int) int { return rd })
if fmt.Sprint(r2) != "[0 1 2]" {
	os.Exit(2)
}
r3 := barrierRounds(5, 1, func(w, rd int) int { return 2 })
if fmt.Sprint(r3) != "[10]" {
	os.Exit(3)
}`, canonical: `func barrierRounds(workers, rounds int, work func(worker, round int) int) []int {
	sums := make([]int, rounds)
	contrib := make(chan int)
	release := make([]chan struct{}, workers)
	for i := range release {
		release[i] = make(chan struct{})
	}
	for w := 0; w < workers; w++ {
		go func(id int) {
			for r := 0; r < rounds; r++ {
				contrib <- work(id, r)
				<-release[id]
			}
		}(w)
	}
	for r := 0; r < rounds; r++ {
		s := 0
		for w := 0; w < workers; w++ {
			s += <-contrib
		}
		sums[r] = s
		for w := 0; w < workers; w++ {
			release[w] <- struct{}{}
		}
	}
	return sums
}` },

{ id: 'go-05-concurrent-first-match', lang: 'go', prompt: `Go: 实现 func firstMatch(data []int, workers int, pred func(int) bool) int。把 data 按连续块划分给最多 workers 个 goroutine 并发扫描,返回 pred 为真的元素的最小下标(全局最小,与哪个 goroutine 先返回无关);若无匹配返回 -1。data 可能为空;workers 可能大于 len(data);匹配可能跨越块边界,但结果必须是全局最小下标。提示:每个 worker 在自己块内按升序找到第一个命中并上报其下标(块内无命中上报 -1),主流程对所有上报取最小值(只用 channel + goroutine,不要 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `data := []int{3, 7, 4, 9, 2, 11, 6, 8, 13, 5}
if firstMatch(data, 4, func(x int) bool { return x%2 == 0 }) != 2 {
	os.Exit(1)
}
if firstMatch(data, 3, func(x int) bool { return x > 100 }) != -1 {
	os.Exit(2)
}
if firstMatch(data, 4, func(x int) bool { return x == 3 }) != 0 {
	os.Exit(3)
}
if firstMatch(data, 5, func(x int) bool { return x == 5 }) != 9 {
	os.Exit(4)
}
if firstMatch([]int{}, 3, func(x int) bool { return true }) != -1 {
	os.Exit(5)
}
if firstMatch([]int{42}, 8, func(x int) bool { return x == 42 }) != 0 {
	os.Exit(6)
}
big := make([]int, 100)
for i := range big {
	big[i] = i
}
if firstMatch(big, 7, func(x int) bool { return x == 50 }) != 50 {
	os.Exit(7)
}`, canonical: `func firstMatch(data []int, workers int, pred func(int) bool) int {
	n := len(data)
	if n == 0 {
		return -1
	}
	if workers > n {
		workers = n
	}
	results := make(chan int, workers)
	chunk := (n + workers - 1) / workers
	spawned := 0
	for start := 0; start < n; start += chunk {
		end := start + chunk
		if end > n {
			end = n
		}
		spawned++
		go func(lo, hi int) {
			for i := lo; i < hi; i++ {
				if pred(data[i]) {
					results <- i
					return
				}
			}
			results <- -1
		}(start, end)
	}
	best := -1
	for i := 0; i < spawned; i++ {
		idx := <-results
		if idx >= 0 && (best == -1 || idx < best) {
			best = idx
		}
	}
	return best
}` },

{ id: 'go-06-select-timeout-drain', lang: 'go', prompt: `Go: 实现 func drainUntilTimeout(work <-chan int, timeout <-chan struct{}) []int。用 select 持续从 work 读取整数追加到结果切片:若 work 被 close 则正常返回已收集的全部值;若 timeout 通道触发(收到值或被 close)则立即停止并返回当前已收集的值。两个事件不会同时就绪(测试保证),正常完成路径与超时路径都要支持,超时前未读到任何值时返回空切片。提示:for + select 两个 case,work 用逗号-ok 形式区分 close(只用 channel + goroutine,不要 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `work := make(chan int)
timeout := make(chan struct{})
go func() {
	for i := 1; i <= 5; i++ {
		work <- i
	}
	close(work)
}()
r := drainUntilTimeout(work, timeout)
if fmt.Sprint(r) != "[1 2 3 4 5]" {
	os.Exit(1)
}

work2 := make(chan int)
timeout2 := make(chan struct{})
collected := make(chan []int, 1)
go func() { collected <- drainUntilTimeout(work2, timeout2) }()
work2 <- 10
work2 <- 20
work2 <- 30
close(timeout2)
r2 := <-collected
if fmt.Sprint(r2) != "[10 20 30]" {
	os.Exit(2)
}

work3 := make(chan int)
timeout3 := make(chan struct{})
close(timeout3)
r3 := drainUntilTimeout(work3, timeout3)
if fmt.Sprint(r3) != "[]" {
	os.Exit(3)
}`, canonical: `func drainUntilTimeout(work <-chan int, timeout <-chan struct{}) []int {
	out := []int{}
	for {
		select {
		case v, ok := <-work:
			if !ok {
				return out
			}
			out = append(out, v)
		case <-timeout:
			return out
		}
	}
}` },

{ id: 'go-07-generic-binary-heap', lang: 'go', prompt: `Go: 用 Go 泛型从零实现一个二叉堆优先队列(不要用 container/heap 或 sort)。定义 type PQ[T any] struct(任意你需要的字段)、构造函数 func NewPQ[T any](less func(a, b T) bool) *PQ[T],以及方法 func (p *PQ[T]) Len() int、func (p *PQ[T]) Push(x T)、func (p *PQ[T]) Pop() T。less(a,b) 为真表示 a 的优先级更高(应更早被 Pop)。Push 后 Pop 必须按 less 定义的顺序逐个弹出(手写上浮/下沉)。支持重复元素;Pop 不会在空堆上调用。提示:用切片做堆数组,父 (i-1)/2,子 2i+1/2i+2(纯逻辑,无需 import)。只返回函数/类型/方法(无 package/import/main,纯逻辑),用 \`\`\`go 包裹,不要解释。`, test: `pq := NewPQ[int](func(a, b int) bool { return a < b })
for _, v := range []int{5, 1, 8, 3, 9, 2, 7, 4, 6, 0} {
	pq.Push(v)
}
out := []int{}
for pq.Len() > 0 {
	out = append(out, pq.Pop())
}
if fmt.Sprint(out) != "[0 1 2 3 4 5 6 7 8 9]" {
	os.Exit(1)
}
sq := NewPQ[string](func(a, b string) bool { return a > b })
for _, s := range []string{"banana", "apple", "cherry"} {
	sq.Push(s)
}
o2 := []string{}
for sq.Len() > 0 {
	o2 = append(o2, sq.Pop())
}
if fmt.Sprint(o2) != "[cherry banana apple]" {
	os.Exit(2)
}
dq := NewPQ[int](func(a, b int) bool { return a < b })
for _, v := range []int{3, 1, 3, 1, 2, 2} {
	dq.Push(v)
}
o3 := []int{}
for dq.Len() > 0 {
	o3 = append(o3, dq.Pop())
}
if fmt.Sprint(o3) != "[1 1 2 2 3 3]" {
	os.Exit(3)
}
xq := NewPQ[int](func(a, b int) bool { return a < b })
xq.Push(42)
if xq.Pop() != 42 || xq.Len() != 0 {
	os.Exit(4)
}`, canonical: `type PQ[T any] struct {
	data []T
	less func(a, b T) bool
}

func NewPQ[T any](less func(a, b T) bool) *PQ[T] {
	return &PQ[T]{less: less}
}

func (p *PQ[T]) Len() int { return len(p.data) }

func (p *PQ[T]) Push(x T) {
	p.data = append(p.data, x)
	i := len(p.data) - 1
	for i > 0 {
		parent := (i - 1) / 2
		if p.less(p.data[i], p.data[parent]) {
			p.data[i], p.data[parent] = p.data[parent], p.data[i]
			i = parent
		} else {
			break
		}
	}
}

func (p *PQ[T]) Pop() T {
	n := len(p.data)
	top := p.data[0]
	p.data[0] = p.data[n-1]
	p.data = p.data[:n-1]
	n--
	i := 0
	for {
		l, r := 2*i+1, 2*i+2
		smallest := i
		if l < n && p.less(p.data[l], p.data[smallest]) {
			smallest = l
		}
		if r < n && p.less(p.data[r], p.data[smallest]) {
			smallest = r
		}
		if smallest == i {
			break
		}
		p.data[i], p.data[smallest] = p.data[smallest], p.data[i]
		i = smallest
	}
	return top
}` },

{ id: 'go-08-interface-expr-eval', lang: 'go', prompt: `Go: 用接口与多态实现一个整数表达式求值器。定义接口 type Expr interface { Eval(env map[string]int) int },以及实现该接口的具体类型:Lit{V int}(字面量)、Var{Name string}(变量,未定义时取 0)、BinOp{Op byte; L, R Expr}(二元运算,Op 为 '+' '-' '*' '/')、Neg{X Expr}(取负)。Eval 递归求值,env 提供变量取值。表达式树可任意嵌套,需正确处理多态调度(同一 []Expr 里混放不同具体类型)。提示:BinOp.Eval 先递归求 L、R 再按 Op 运算(纯逻辑,无需 import)。只返回类型/方法(无 package/import/main,纯逻辑),用 \`\`\`go 包裹,不要解释。`, test: `e := BinOp{'*',
	BinOp{'+', Var{"x"}, Lit{3}},
	Neg{BinOp{'-', Var{"y"}, Lit{1}}},
}
env := map[string]int{"x": 4, "y": 5}
if e.Eval(env) != -28 {
	os.Exit(1)
}
e2 := BinOp{'*',
	BinOp{'-', BinOp{'/', Lit{20}, Lit{4}}, Lit{2}},
	BinOp{'+', Var{"z"}, Lit{0}},
}
if e2.Eval(map[string]int{"z": 10}) != 30 {
	os.Exit(2)
}
exprs := []Expr{Lit{1}, Var{"a"}, Neg{Lit{5}}, BinOp{'+', Lit{2}, Lit{2}}}
sum := 0
for _, x := range exprs {
	sum += x.Eval(map[string]int{"a": 100})
}
if sum != 100 {
	os.Exit(3)
}
if (Var{"missing"}).Eval(map[string]int{}) != 0 {
	os.Exit(4)
}`, canonical: `type Expr interface {
	Eval(env map[string]int) int
}

type Lit struct{ V int }

func (l Lit) Eval(env map[string]int) int { return l.V }

type Var struct{ Name string }

func (v Var) Eval(env map[string]int) int { return env[v.Name] }

type BinOp struct {
	Op   byte
	L, R Expr
}

func (b BinOp) Eval(env map[string]int) int {
	l, r := b.L.Eval(env), b.R.Eval(env)
	switch b.Op {
	case '+':
		return l + r
	case '-':
		return l - r
	case '*':
		return l * r
	case '/':
		return l / r
	}
	panic("bad op")
}

type Neg struct{ X Expr }

func (n Neg) Eval(env map[string]int) int { return -n.X.Eval(env) }` },

{ id: 'go-09-handwritten-stable-sort', lang: 'go', prompt: `Go: 不使用 sort 包,手写一个稳定排序。给定 type Person struct { Name string; Age int; Id int },实现 func stableSort(people []Person) []Person:按 Age 升序排序,Age 相同则按 Name 升序;在 Age 与 Name 都相同的元素之间必须保持它们在输入中的原始相对顺序(稳定性,Id 字段不参与比较但可借此观察)。不得修改入参切片(返回新切片)。需处理空切片、单元素、奇数长度、已序、逆序。提示:自顶向下或自底向上归并排序,合并时相等元素优先取左半段以保证稳定(纯逻辑,无需 import)。只返回类型/函数(无 package/import/main,纯逻辑),用 \`\`\`go 包裹,不要解释。`, test: `in := []Person{
	{"X", 5, 0}, {"A", 5, 1}, {"X", 5, 2}, {"B", 3, 3}, {"X", 5, 4}, {"A", 5, 5},
}
got := stableSort(in)
want := "[{B 3 3} {A 5 1} {A 5 5} {X 5 0} {X 5 2} {X 5 4}]"
if fmt.Sprint(got) != want {
	os.Exit(1)
}
if fmt.Sprint(in[0]) != "{X 5 0}" {
	os.Exit(2)
}
in2 := make([]Person, 7)
for i := range in2 {
	in2[i] = Person{"Q", 1, i}
}
got2 := stableSort(in2)
if fmt.Sprint(got2) != "[{Q 1 0} {Q 1 1} {Q 1 2} {Q 1 3} {Q 1 4} {Q 1 5} {Q 1 6}]" {
	os.Exit(3)
}
if fmt.Sprint(stableSort([]Person{})) != "[]" {
	os.Exit(4)
}
if fmt.Sprint(stableSort([]Person{{"Z", 9, 7}})) != "[{Z 9 7}]" {
	os.Exit(5)
}
in3 := []Person{{"M", 2, 0}, {"M", 2, 1}, {"M", 1, 2}, {"M", 1, 3}}
got3 := stableSort(in3)
if fmt.Sprint(got3) != "[{M 1 2} {M 1 3} {M 2 0} {M 2 1}]" {
	os.Exit(6)
}`, canonical: `type Person struct {
	Name string
	Age  int
	Id   int
}

func stableSort(people []Person) []Person {
	n := len(people)
	a := make([]Person, n)
	copy(a, people)
	buf := make([]Person, n)
	less := func(x, y Person) bool {
		if x.Age != y.Age {
			return x.Age < y.Age
		}
		return x.Name < y.Name
	}
	for width := 1; width < n; width *= 2 {
		for i := 0; i < n; i += 2 * width {
			lo := i
			mid := i + width
			hi := i + 2*width
			if mid > n {
				mid = n
			}
			if hi > n {
				hi = n
			}
			l, r, k := lo, mid, lo
			for l < mid && r < hi {
				if less(a[r], a[l]) {
					buf[k] = a[r]
					r++
				} else {
					buf[k] = a[l]
					l++
				}
				k++
			}
			for l < mid {
				buf[k] = a[l]
				l++
				k++
			}
			for r < hi {
				buf[k] = a[r]
				r++
				k++
			}
			copy(a[lo:hi], buf[lo:hi])
		}
	}
	return a
}` },

{ id: 'go-10-round-robin-coordinator', lang: 'go', prompt: `Go: 实现 func roundRobin(k, rounds int) []int。启动 k 个 worker goroutine,由主流程(协调者)按严格轮转顺序 0,1,...,k-1,0,1,... 逐个授予"轮次",共进行 rounds 个完整循环。某个 worker 拿到轮次时把自己的 id 追加到(协调者持有的)日志并发回确认;整个过程由握手严格串行化,因此日志必然是 [0,1,...,k-1] 重复 rounds 次。返回该有序日志。k<=0 或 rounds<=0 时返回空切片。注意避免自我发送/终止导致的死锁。提示:每个 worker 一个"该你了"通道 + 一个公共 ack 通道 + 一个退出通道,协调者发一个放行收一个 ack(只用 channel + goroutine,不要 sync/time)。只返回函数(无 package/import/main,纯逻辑/仅 channel 并发),用 \`\`\`go 包裹,不要解释。`, test: `if fmt.Sprint(roundRobin(3, 2)) != "[0 1 2 0 1 2]" {
	os.Exit(1)
}
if fmt.Sprint(roundRobin(1, 4)) != "[0 0 0 0]" {
	os.Exit(2)
}
if fmt.Sprint(roundRobin(4, 1)) != "[0 1 2 3]" {
	os.Exit(3)
}
if fmt.Sprint(roundRobin(2, 3)) != "[0 1 0 1 0 1]" {
	os.Exit(4)
}
if fmt.Sprint(roundRobin(0, 5)) != "[]" {
	os.Exit(5)
}
if fmt.Sprint(roundRobin(3, 0)) != "[]" {
	os.Exit(6)
}`, canonical: `func roundRobin(k, rounds int) []int {
	if k <= 0 || rounds <= 0 {
		return []int{}
	}
	turn := make([]chan struct{}, k)
	ack := make(chan int)
	quit := make([]chan struct{}, k)
	for i := 0; i < k; i++ {
		turn[i] = make(chan struct{})
		quit[i] = make(chan struct{})
		go func(id int) {
			for {
				select {
				case <-turn[id]:
					ack <- id
				case <-quit[id]:
					return
				}
			}
		}(i)
	}
	log := make([]int, 0, k*rounds)
	for r := 0; r < rounds; r++ {
		for i := 0; i < k; i++ {
			turn[i] <- struct{}{}
			log = append(log, <-ack)
		}
	}
	for i := 0; i < k; i++ {
		close(quit[i])
	}
	return log
}` }
];
