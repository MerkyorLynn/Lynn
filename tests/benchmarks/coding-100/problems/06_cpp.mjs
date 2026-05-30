export default [
  {
    id: 'cpp-01-segtree-lazy',
    lang: 'cpp',
    prompt: `C++17 实现一个支持区间加 + 区间最小值查询的懒标记线段树 struct SegTree。要求成员:
- 构造 SegTree(const vector<long long>& a) 用初始数组 a 建树(下标 0..n-1)。
- void rangeAdd(int l,int r,long long v) 给闭区间 [l,r] 每个元素加 v(v 可为负)。
- long long rangeMin(int l,int r) 返回闭区间 [l,r] 的最小值。
必须用懒标记(lazy propagation),保证多次区间加与查询交错时结果正确,值可能超过 int 范围。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `vector<long long> a={5,3,8,1,9,2,7};
SegTree st(a);
assert(st.rangeMin(0,6)==1);
assert(st.rangeMin(0,2)==3);
st.rangeAdd(2,4,10);
assert(st.rangeMin(2,4)==11);
assert(st.rangeMin(0,6)==2);
st.rangeAdd(0,6,-2);
assert(st.rangeMin(0,6)==0);
assert(st.rangeMin(3,3)==9);
st.rangeAdd(5,6,100);
assert(st.rangeMin(5,6)==100);
assert(st.rangeMin(0,6)==1);
assert(st.rangeMin(0,4)==1);`,
    canonical: `struct SegTree {
    int n;
    vector<long long> mn, lazy;
    SegTree(const vector<long long>& a){
        n = a.size();
        mn.assign(4*n, 0);
        lazy.assign(4*n, 0);
        build(1,0,n-1,a);
    }
    void build(int node,int l,int r,const vector<long long>& a){
        if(l==r){ mn[node]=a[l]; return; }
        int m=(l+r)/2;
        build(2*node,l,m,a);
        build(2*node+1,m+1,r,a);
        mn[node]=min(mn[2*node],mn[2*node+1]);
    }
    void push(int node){
        if(lazy[node]!=0){
            for(int c: {2*node,2*node+1}){
                mn[c]+=lazy[node];
                lazy[c]+=lazy[node];
            }
            lazy[node]=0;
        }
    }
    void update(int node,int l,int r,int ql,int qr,long long val){
        if(qr<l||r<ql) return;
        if(ql<=l&&r<=qr){ mn[node]+=val; lazy[node]+=val; return; }
        push(node);
        int m=(l+r)/2;
        update(2*node,l,m,ql,qr,val);
        update(2*node+1,m+1,r,ql,qr,val);
        mn[node]=min(mn[2*node],mn[2*node+1]);
    }
    long long query(int node,int l,int r,int ql,int qr){
        if(qr<l||r<ql) return LLONG_MAX;
        if(ql<=l&&r<=qr) return mn[node];
        push(node);
        int m=(l+r)/2;
        return min(query(2*node,l,m,ql,qr), query(2*node+1,m+1,r,ql,qr));
    }
    void rangeAdd(int l,int r,long long v){ update(1,0,n-1,l,r,v); }
    long long rangeMin(int l,int r){ return query(1,0,n-1,l,r); }
};`
  },
  {
    id: 'cpp-02-template-flatten',
    lang: 'cpp',
    prompt: `C++17 用模板递归实现任意嵌套 vector 的扁平化。给定一个类型 V(可能是 int、vector<int>、vector<vector<int>>、vector<vector<vector<string>>> 等任意深度嵌套的 vector),实现:
- 一个类型萃取 template<class T> struct scalar_type { using type = ...; }; 它把所有 vector<> 层剥掉,得到最内层的标量类型。
- 模板函数 template<class V> vector<typename scalar_type<V>::type> flatten(const V& v);  按从左到右、深度优先的顺序把所有标量收集进一个一维 vector 返回。
要求返回类型精确为 vector<最内层标量类型>(例如 flatten(vector<vector<vector<int>>>) 的返回类型必须是 vector<int>)。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `vector<vector<vector<int>>> a = {{{1,2},{3}}, {{4},{5,6,7}}, {{}}};
auto f = flatten(a);
vector<int> exp = {1,2,3,4,5,6,7};
assert(f == exp);

vector<vector<int>> b = {{9},{},{8,7}};
auto g = flatten(b);
vector<int> exp2 = {9,8,7};
assert(g == exp2);

vector<int> c = {10,20,30};
auto h = flatten(c);
assert(h == c);

vector<vector<vector<string>>> s = {{{"x"},{"y","z"}}};
auto fs = flatten(s);
assert(fs.size()==3 && fs[0]=="x" && fs[1]=="y" && fs[2]=="z");
static_assert(is_same<decltype(f), vector<int>>::value, "type");`,
    canonical: `template<class T> struct scalar_type { using type = T; };
template<class U> struct scalar_type<vector<U>> { using type = typename scalar_type<U>::type; };

template<class T, class Out>
void append_flat(const T& x, Out& out){ out.push_back(x); }
template<class U, class Out>
void append_flat(const vector<U>& v, Out& out){
    for(const auto& e : v) append_flat(e, out);
}

template<class V>
vector<typename scalar_type<V>::type> flatten(const V& v){
    vector<typename scalar_type<V>::type> out;
    append_flat(v, out);
    return out;
}`
  },
  {
    id: 'cpp-03-move-only-buffer',
    lang: 'cpp',
    prompt: `C++17 实现一个 only-move(禁止拷贝)的动态 int 缓冲区 struct Buf,自己用裸指针管理内存(new[]/delete[]),不得用 vector 做底层存储。要求:
- 公开成员 int* data; size_t sz; size_t cap;(初始 data=nullptr, sz=cap=0)。
- void push_back(int x):容量不足时按倍增扩容(cap 从 0->1->2->4...)。
- size_t size() const;  int& operator[](size_t); 以及 const 版 int operator[](size_t) const;
- 拷贝构造与拷贝赋值必须被 = delete。
- 移动构造与移动赋值:窃取对方指针,并把对方置为空(data=nullptr, sz=0, cap=0);移动赋值需正确处理自赋值并释放自身原有内存。
- 析构释放内存,且不得二次释放。
- 自由函数 Buf concat(Buf&& a, Buf&& b):返回把 b 的元素接到 a 之后的新 Buf(应复用 a 的缓冲区)。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `static_assert(!is_copy_constructible<Buf>::value, "no copy");
static_assert(is_move_constructible<Buf>::value, "move ok");
Buf a;
for(int i=0;i<5;i++) a.push_back(i*i);
assert(a.size()==5 && a[3]==9);
Buf b = std::move(a);
assert(b.size()==5 && b[4]==16);
assert(a.size()==0 && a.data==nullptr);
Buf c;
c.push_back(100); c.push_back(200);
Buf d = concat(std::move(b), std::move(c));
assert(d.size()==7);
assert(d[0]==0 && d[4]==16 && d[5]==100 && d[6]==200);
Buf e;
e.push_back(-1);
e = std::move(d);
assert(e.size()==7 && e[6]==200);
assert(d.data==nullptr && d.size()==0);`,
    canonical: `struct Buf {
    int* data = nullptr;
    size_t sz = 0, cap = 0;
    Buf() = default;
    Buf(const Buf&) = delete;
    Buf& operator=(const Buf&) = delete;
    Buf(Buf&& o) noexcept : data(o.data), sz(o.sz), cap(o.cap) {
        o.data = nullptr; o.sz = 0; o.cap = 0;
    }
    Buf& operator=(Buf&& o) noexcept {
        if(this != &o){
            delete[] data;
            data = o.data; sz = o.sz; cap = o.cap;
            o.data = nullptr; o.sz = 0; o.cap = 0;
        }
        return *this;
    }
    ~Buf(){ delete[] data; }
    void push_back(int x){
        if(sz == cap){
            size_t ncap = cap ? cap*2 : 1;
            int* nd = new int[ncap];
            for(size_t i=0;i<sz;i++) nd[i]=data[i];
            delete[] data;
            data = nd; cap = ncap;
        }
        data[sz++] = x;
    }
    size_t size() const { return sz; }
    int& operator[](size_t i){ return data[i]; }
    int operator[](size_t i) const { return data[i]; }
};
Buf concat(Buf&& a, Buf&& b){
    Buf r = std::move(a);
    for(size_t i=0;i<b.size();i++) r.push_back(b[i]);
    return r;
}`
  },
  {
    id: 'cpp-04-maximal-rectangle',
    lang: 'cpp',
    prompt: `C++17 实现 long long maximalRectangle(const vector<vector<int>>& grid),grid 为只含 0/1 的二维矩阵,返回其中全为 1 的最大轴对齐矩形面积。要求使用逐行直方图 + 单调栈的 O(R*C) 算法(不要用 O((R*C)^2) 暴力)。空矩阵或空行返回 0。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `vector<vector<int>> g1 = {
  {1,0,1,0,0},
  {1,0,1,1,1},
  {1,1,1,1,1},
  {1,0,0,1,0}
};
assert(maximalRectangle(g1)==6);
vector<vector<int>> g2 = {{0}};
assert(maximalRectangle(g2)==0);
vector<vector<int>> g3 = {{1}};
assert(maximalRectangle(g3)==1);
vector<vector<int>> g4 = {
  {1,1,1},
  {1,1,1},
  {1,1,1}
};
assert(maximalRectangle(g4)==9);
vector<vector<int>> g5 = {
  {0,1,1,0},
  {1,1,1,1},
  {1,1,1,1},
  {1,1,0,0}
};
assert(maximalRectangle(g5)==8);
vector<vector<int>> g6;
assert(maximalRectangle(g6)==0);`,
    canonical: `long long maximalRectangle(const vector<vector<int>>& grid){
    if(grid.empty() || grid[0].empty()) return 0;
    int R = grid.size(), C = grid[0].size();
    vector<int> h(C, 0);
    long long best = 0;
    for(int r=0;r<R;r++){
        for(int c=0;c<C;c++) h[c] = grid[r][c] ? h[c]+1 : 0;
        vector<int> st;
        for(int c=0;c<=C;c++){
            int cur = (c==C) ? 0 : h[c];
            while(!st.empty() && h[st.back()] >= cur){
                int height = h[st.back()];
                st.pop_back();
                int left = st.empty() ? -1 : st.back();
                long long width = c - left - 1;
                best = max(best, (long long)height * width);
            }
            st.push_back(c);
        }
    }
    return best;
}`
  },
  {
    id: 'cpp-05-parity-dsu',
    lang: 'cpp',
    prompt: `C++17 实现带奇偶(关系)信息的并查集 struct ParityDSU,用于维护"同色/异色"约束(等价于带权并查集 / 判二分图)。要求:
- 构造 ParityDSU(int n):n 个独立节点 0..n-1。
- bool unite(int a,int b,int d):声明 a 与 b 的相对奇偶关系为 d(d=0 表示同色,d=1 表示异色)。若该声明与已有信息矛盾则返回 false 且不改变结构;否则合并并返回 true。
- bool connected(int a,int b):a、b 是否已在同一集合。
- int relation(int a,int b):若不连通返回 -1;否则返回二者的相对奇偶(0 同色 / 1 异色)。
内部需用路径压缩维护每个节点相对根的奇偶值,保证 union 和查询都接近 O(α(n))。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `ParityDSU d(6);
assert(d.unite(0,1,1));
assert(d.unite(1,2,1));
assert(d.relation(0,2)==0);
assert(d.relation(0,1)==1);
assert(d.connected(0,2));
assert(!d.connected(0,5));
assert(d.relation(0,5)==-1);
assert(!d.unite(0,2,1));
assert(d.unite(0,2,0));
ParityDSU e(3);
assert(e.unite(0,1,1));
assert(e.unite(1,2,1));
assert(!e.unite(2,0,1));
assert(e.unite(2,0,0));
assert(e.relation(0,2)==0);`,
    canonical: `struct ParityDSU {
    vector<int> par;
    vector<int> rnk;
    vector<int> rel;
    ParityDSU(int n): par(n), rnk(n,0), rel(n,0){
        for(int i=0;i<n;i++) par[i]=i;
    }
    pair<int,int> find(int x){
        if(par[x]==x) return {x,0};
        auto [r,p] = find(par[x]);
        par[x] = r;
        rel[x] ^= p;
        return {r, rel[x]};
    }
    bool unite(int a,int b,int d){
        auto [ra,pa] = find(a);
        auto [rb,pb] = find(b);
        if(ra==rb){
            return ((pa ^ pb) == d);
        }
        if(rnk[ra] < rnk[rb]){ swap(ra,rb); swap(pa,pb); }
        par[rb] = ra;
        rel[rb] = pa ^ pb ^ d;
        if(rnk[ra]==rnk[rb]) rnk[ra]++;
        return true;
    }
    bool connected(int a,int b){ return find(a).first == find(b).first; }
    int relation(int a,int b){
        auto [ra,pa] = find(a);
        auto [rb,pb] = find(b);
        if(ra!=rb) return -1;
        return pa ^ pb;
    }
};`
  },
  {
    id: 'cpp-06-sliding-window-max',
    lang: 'cpp',
    prompt: `C++17 实现 vector<int> maxSlidingWindow(const vector<int>& nums, int k):返回每个长度为 k 的滑动窗口的最大值(从左到右)。要求使用单调双端队列(deque)做到 O(n)(不要每窗口重新扫描)。若 k<=0 或 k>nums.size() 返回空 vector。注意正确处理重复值与负数。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `vector<int> a = {1,3,-1,-3,5,3,6,7};
vector<int> r = maxSlidingWindow(a,3);
vector<int> exp = {3,3,5,5,6,7};
assert(r==exp);
vector<int> b = {9,8,7,6};
assert(maxSlidingWindow(b,1)==b);
assert(maxSlidingWindow(b,4)==(vector<int>{9}));
assert(maxSlidingWindow(b,5).empty());
assert(maxSlidingWindow(b,0).empty());
vector<int> c = {4,4,4,4};
assert(maxSlidingWindow(c,2)==(vector<int>{4,4,4}));
vector<int> d = {-7,-8,-9,-1};
assert(maxSlidingWindow(d,2)==(vector<int>{-7,-8,-1}));`,
    canonical: `vector<int> maxSlidingWindow(const vector<int>& nums, int k){
    vector<int> res;
    int n = nums.size();
    if(k<=0 || k>n) return res;
    deque<int> dq;
    for(int i=0;i<n;i++){
        while(!dq.empty() && dq.front() <= i-k) dq.pop_front();
        while(!dq.empty() && nums[dq.back()] <= nums[i]) dq.pop_back();
        dq.push_back(i);
        if(i >= k-1) res.push_back(nums[dq.front()]);
    }
    return res;
}`
  },
  {
    id: 'cpp-07-bigint',
    lang: 'cpp',
    prompt: `C++17 实现一个任意精度非负整数 struct BigInt,支持运算符重载。要求:
- BigInt():值为 0。
- BigInt(const string& s):从十进制数字串构造(可能含前导零,需正确归一)。
- BigInt(long long v):从非负整型构造。
- BigInt operator+(const BigInt&) const:大数加法。
- BigInt operator*(const BigInt&) const:大数乘法(可用竖式 O(n*m))。
- bool operator==(const BigInt&) const 与 bool operator<(const BigInt&) const。
- string str() const:十进制表示,除 "0" 外无前导零。
需正确处理任意位数(远超 64 位)的进位与比较。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `BigInt a("99999999999999999999");
BigInt b("1");
assert((a+b).str()=="100000000000000000000");
BigInt c("123456789");
BigInt e("987654321");
assert((c*e).str()=="121932631112635269");
BigInt z("0");
assert((z+z).str()=="0");
assert((c*z).str()=="0");
assert((z*c).str()=="0");
BigInt f("000123");
assert(f.str()=="123");
assert((BigInt("2")*BigInt("2")).str()=="4");
BigInt fac(1LL);
for(int i=2;i<=20;i++) fac = fac * BigInt((long long)i);
assert(fac.str()=="2432902008176640000");
BigInt big1("12345678901234567890");
BigInt big2("98765432109876543210");
assert((big1*big2).str()=="1219326311370217952237463801111263526900");
assert(BigInt("100") < BigInt("1000"));
assert(BigInt("999") < BigInt("1000"));
assert(!(BigInt("1000") < BigInt("999")));
assert(BigInt("5")==BigInt("5"));
assert(!(BigInt("5")==BigInt("6")));
assert(BigInt("0").str()=="0");`,
    canonical: `struct BigInt {
    vector<int> d;
    BigInt(){ d = {0}; }
    BigInt(const string& s){
        int i = 0;
        while(i+1 < (int)s.size() && s[i]=='0') i++;
        for(int j=(int)s.size()-1;j>=i;j--) d.push_back(s[j]-'0');
        if(d.empty()) d={0};
        trim();
    }
    BigInt(long long v){
        if(v==0){ d={0}; return; }
        while(v>0){ d.push_back(v%10); v/=10; }
    }
    void trim(){
        while(d.size()>1 && d.back()==0) d.pop_back();
    }
    BigInt operator+(const BigInt& o) const {
        BigInt r; r.d.clear();
        int carry=0;
        size_t n = max(d.size(), o.d.size());
        for(size_t i=0;i<n || carry;i++){
            int s = carry;
            if(i<d.size()) s += d[i];
            if(i<o.d.size()) s += o.d[i];
            r.d.push_back(s%10);
            carry = s/10;
        }
        if(r.d.empty()) r.d={0};
        r.trim();
        return r;
    }
    BigInt operator*(const BigInt& o) const {
        vector<long long> tmp(d.size()+o.d.size(), 0);
        for(size_t i=0;i<d.size();i++)
            for(size_t j=0;j<o.d.size();j++)
                tmp[i+j] += (long long)d[i]*o.d[j];
        BigInt r; r.d.assign(tmp.size(),0);
        long long carry=0;
        for(size_t i=0;i<tmp.size();i++){
            long long cur = tmp[i]+carry;
            r.d[i] = cur%10;
            carry = cur/10;
        }
        while(carry){ r.d.push_back(carry%10); carry/=10; }
        r.trim();
        return r;
    }
    bool operator==(const BigInt& o) const { return d==o.d; }
    bool operator<(const BigInt& o) const {
        if(d.size()!=o.d.size()) return d.size()<o.d.size();
        for(int i=(int)d.size()-1;i>=0;i--)
            if(d[i]!=o.d[i]) return d[i]<o.d[i];
        return false;
    }
    string str() const {
        string s;
        for(int i=(int)d.size()-1;i>=0;i--) s += char('0'+d[i]);
        return s;
    }
};`
  },
  {
    id: 'cpp-08-grid-path-k-obstacles',
    lang: 'cpp',
    prompt: `C++17 实现 int shortestPathWithObstacles(const vector<vector<int>>& grid, int k):grid 中 0 表示空格、1 表示墙。从左上角 (0,0) 到右下角 (R-1,C-1),每步可上下左右移动一格,最多可以"穿过"k 个墙(经过墙格会消耗一次配额,起点/终点若是墙也算)。返回最短步数,无法到达返回 -1。需在状态 (行, 列, 剩余配额) 上做 BFS,保证最优步数正确。空网格返回 -1;1x1 网格起点即终点(步数 0,但若起点是墙且 k=0 则 -1)。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `vector<vector<int>> g1 = {
  {0,0,0},
  {1,1,0},
  {0,0,0},
  {0,1,1},
  {0,0,0}
};
assert(shortestPathWithObstacles(g1,1)==6);
vector<vector<int>> g2 = {
  {0,1,1},
  {1,1,0},
  {1,0,0}
};
assert(shortestPathWithObstacles(g2,1)==-1);
vector<vector<int>> g3 = {
  {0,0,0},
  {0,0,0},
  {0,0,0}
};
assert(shortestPathWithObstacles(g3,0)==4);
vector<vector<int>> g4 = {{0}};
assert(shortestPathWithObstacles(g4,0)==0);
vector<vector<int>> g5 = {{1}};
assert(shortestPathWithObstacles(g5,0)==-1);
assert(shortestPathWithObstacles(g5,1)==0);
vector<vector<int>> g6 = {
  {0,1,0,1,0}
};
assert(shortestPathWithObstacles(g6,2)==4);
assert(shortestPathWithObstacles(g6,1)==-1);`,
    canonical: `int shortestPathWithObstacles(const vector<vector<int>>& grid, int k){
    int R = grid.size(); if(R==0) return -1;
    int C = grid[0].size(); if(C==0) return -1;
    if(k > R*C) k = R*C;
    vector<vector<vector<char>>> vis(R, vector<vector<char>>(C, vector<char>(k+1, 0)));
    int sk = k - grid[0][0];
    if(sk < 0) return -1;
    deque<array<int,4>> q;
    q.push_back({0,0,sk,0});
    vis[0][0][sk]=1;
    int dr[]={1,-1,0,0}, dc[]={0,0,1,-1};
    while(!q.empty()){
        auto [r,c,rem,dist] = q.front(); q.pop_front();
        if(r==R-1 && c==C-1) return dist;
        for(int i=0;i<4;i++){
            int nr=r+dr[i], nc=c+dc[i];
            if(nr<0||nr>=R||nc<0||nc>=C) continue;
            int nrem = rem - grid[nr][nc];
            if(nrem < 0) continue;
            if(vis[nr][nc][nrem]) continue;
            vis[nr][nc][nrem]=1;
            q.push_back({nr,nc,nrem,dist+1});
        }
    }
    return -1;
}`
  },
  {
    id: 'cpp-09-variadic-compose',
    lang: 'cpp',
    prompt: `C++17 实现变参函数组合 compose,满足 compose(f,g,h)(x) == f(g(h(x))),compose(f)(x) == f(x)。要求:
- 用变参模板 + 泛型 lambda(auto&&... + 完美转发)实现,返回一个可调用对象。
- 必须支持异构类型链(例如 int -> double -> string 等返回类型在链中变化),不能假设所有函数同类型。
- 至少支持任意数量(>=1)的可调用对象按从右到左的顺序组合。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `auto inc = [](int x){ return x+1; };
auto dbl = [](int x){ return x*2; };
auto sq  = [](int x){ return x*x; };
auto f = compose(inc, dbl, sq);
assert(f(3) == 3*3*2+1);
assert(f(0) == 1);
auto g = compose(sq);
assert(g(5)==25);
auto toHalf = [](int x){ return x/2.0; };
auto ceilToInt = [](double d){ return (int)(d+0.999999); };
auto h = compose(ceilToInt, toHalf);
assert(h(7)==4);
assert(h(8)==4);
assert(h(9)==5);
auto chain = compose(inc, inc, inc, inc);
assert(chain(10)==14);
auto numToStr = [](int x){ return to_string(x); };
auto strLen = [](const string& s){ return (int)s.size(); };
auto pipe = compose(strLen, numToStr, dbl);
assert(pipe(50)==3);
assert(pipe(5)==2);`,
    canonical: `template<class F>
auto compose(F f){
    return [f](auto&&... args){ return f(std::forward<decltype(args)>(args)...); };
}
template<class F, class... Rest>
auto compose(F f, Rest... rest){
    auto tail = compose(rest...);
    return [f, tail](auto&&... args){
        return f(tail(std::forward<decltype(args)>(args)...));
    };
}`
  },
  {
    id: 'cpp-10-lru-cache',
    lang: 'cpp',
    prompt: `C++17 实现一个 O(1) 的 LRU 缓存 struct LRUCache(键值均为 int)。要求:
- 构造 LRUCache(int capacity)(capacity>=1)。
- int get(int key):存在则返回其值并将该键标记为最近使用;不存在返回 -1。
- void put(int key,int val):插入或更新;若插入导致超出容量,淘汰最久未使用的键。更新已存在键也要刷新其最近使用次序。
get 和 put 都必须是均摊 O(1)(用哈希表 + 双向链表,例如 list + unordered_map<int, list 迭代器>,并用 splice 调整次序)。
只返回代码(无 main/include/using),用 \`\`\`cpp 包裹,不要解释。`,
    test: `LRUCache c(2);
c.put(1,1);
c.put(2,2);
assert(c.get(1)==1);
c.put(3,3);
assert(c.get(2)==-1);
assert(c.get(3)==3);
c.put(4,4);
assert(c.get(1)==-1);
assert(c.get(3)==3);
assert(c.get(4)==4);
LRUCache d(2);
d.put(1,10);
d.put(1,11);
assert(d.get(1)==11);
d.put(2,20);
d.put(3,30);
assert(d.get(1)==-1);
assert(d.get(2)==20);
assert(d.get(3)==30);
LRUCache e(1);
e.put(5,50);
assert(e.get(5)==50);
e.put(6,60);
assert(e.get(5)==-1);
assert(e.get(6)==60);
LRUCache f(2);
f.put(1,1); f.put(2,2);
assert(f.get(1)==1);
f.put(3,3);
assert(f.get(2)==-1);
assert(f.get(1)==1);
assert(f.get(3)==3);`,
    canonical: `struct LRUCache {
    int cap;
    list<pair<int,int>> items;
    unordered_map<int, list<pair<int,int>>::iterator> pos;
    LRUCache(int capacity): cap(capacity) {}
    int get(int key){
        auto it = pos.find(key);
        if(it==pos.end()) return -1;
        items.splice(items.begin(), items, it->second);
        return it->second->second;
    }
    void put(int key,int val){
        auto it = pos.find(key);
        if(it!=pos.end()){
            it->second->second = val;
            items.splice(items.begin(), items, it->second);
            return;
        }
        if((int)items.size() >= cap){
            auto last = items.back();
            pos.erase(last.first);
            items.pop_back();
        }
        items.push_front({key,val});
        pos[key] = items.begin();
    }
};`
  }
];
