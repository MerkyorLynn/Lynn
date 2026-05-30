export default [
{ id: 'rs-01-runlength-iter', lang: 'rust', prompt: `Rust: 实现一个零拷贝的运行长度(run-length)迭代器。定义 struct RunLength<'a, T: PartialEq> 并为其 impl Iterator,Item = (&'a T, usize),每次产出 (对该段第一个元素的引用, 该段连续相等元素的个数)。再实现 fn run_length<T: PartialEq>(items: &[T]) -> RunLength<'_, T>。要求迭代器借用输入切片、不复制元素,生命周期标注正确。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let v = vec![1, 1, 2, 3, 3, 3, 1];
let got: Vec<(i32, usize)> = run_length(&v).map(|(x, c)| (*x, c)).collect();
assert_eq!(got, vec![(1, 2), (2, 1), (3, 3), (1, 1)]);
let s = "aaabbc";
let chars: Vec<char> = s.chars().collect();
let got2: Vec<(char, usize)> = run_length(&chars).map(|(x, c)| (*x, c)).collect();
assert_eq!(got2, vec![('a', 3), ('b', 2), ('c', 1)]);
let empty: Vec<i32> = vec![];
assert_eq!(run_length(&empty).count(), 0);`, canonical: `struct RunLength<'a, T: PartialEq> {
    items: &'a [T],
    pos: usize,
}

impl<'a, T: PartialEq> Iterator for RunLength<'a, T> {
    type Item = (&'a T, usize);
    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.items.len() {
            return None;
        }
        let start = self.pos;
        let first = &self.items[start];
        let mut count = 1;
        while self.pos + count < self.items.len() && self.items[self.pos + count] == *first {
            count += 1;
        }
        self.pos += count;
        Some((first, count))
    }
}

fn run_length<T: PartialEq>(items: &[T]) -> RunLength<'_, T> {
    RunLength { items, pos: 0 }
}` },

{ id: 'rs-02-expr-trait-object', lang: 'rust', prompt: `Rust: 用 trait object 构建表达式求值树。定义 trait Expr { fn eval(&self) -> f64; },并定义 Num(f64)、Add、Mul、Neg 四种节点,后三者持有 Box<dyn Expr> 子节点(Add/Mul 各两个,Neg 一个)。各自 impl Expr。再提供构造函数:fn num(x: f64) -> Box<dyn Expr>、fn add(a: Box<dyn Expr>, b: Box<dyn Expr>) -> Box<dyn Expr>、fn mul(...) -> Box<dyn Expr>、fn neg(a: Box<dyn Expr>) -> Box<dyn Expr>。eval 递归求值(Neg 取负)。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let e = mul(add(num(2.0), num(3.0)), neg(num(4.0)));
assert_eq!(e.eval(), -20.0);
let e2 = add(num(1.0), mul(num(2.0), num(3.0)));
assert_eq!(e2.eval(), 7.0);
let e3 = neg(neg(num(5.5)));
assert_eq!(e3.eval(), 5.5);`, canonical: `trait Expr {
    fn eval(&self) -> f64;
}

struct Num(f64);
struct Add(Box<dyn Expr>, Box<dyn Expr>);
struct Mul(Box<dyn Expr>, Box<dyn Expr>);
struct Neg(Box<dyn Expr>);

impl Expr for Num {
    fn eval(&self) -> f64 { self.0 }
}
impl Expr for Add {
    fn eval(&self) -> f64 { self.0.eval() + self.1.eval() }
}
impl Expr for Mul {
    fn eval(&self) -> f64 { self.0.eval() * self.1.eval() }
}
impl Expr for Neg {
    fn eval(&self) -> f64 { -self.0.eval() }
}

fn num(x: f64) -> Box<dyn Expr> { Box::new(Num(x)) }
fn add(a: Box<dyn Expr>, b: Box<dyn Expr>) -> Box<dyn Expr> { Box::new(Add(a, b)) }
fn mul(a: Box<dyn Expr>, b: Box<dyn Expr>) -> Box<dyn Expr> { Box::new(Mul(a, b)) }
fn neg(a: Box<dyn Expr>) -> Box<dyn Expr> { Box::new(Neg(a)) }` },

{ id: 'rs-03-rc-refcell-tree', lang: 'rust', prompt: `Rust: 用 Rc<RefCell<...>> 构建可共享、可变的多叉树并做递归操作。类型别名 type Node = Rc<RefCell<TreeNode>>,TreeNode { val: i32, children: Vec<Node> }。实现:fn node(val: i32) -> Node;fn attach(parent: &Node, child: &Node)(把 child 的 Rc clone 进 parent.children);fn subtree_sum(n: &Node) -> i32(递归求子树 val 之和);fn add_to_all(n: &Node, delta: i32)(给该子树每个节点 val 加 delta)。注意 add_to_all 在 borrow_mut 当前节点后再递归子节点,避免 RefCell 借用冲突 panic。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let root = node(1);
let a = node(2);
let b = node(3);
let c = node(4);
attach(&root, &a);
attach(&root, &b);
attach(&a, &c);
assert_eq!(subtree_sum(&root), 1 + 2 + 3 + 4);
add_to_all(&root, 10);
assert_eq!(subtree_sum(&root), 10 + 40);
assert_eq!(c.borrow().val, 14);
assert_eq!(subtree_sum(&a), 12 + 14);`, canonical: `use std::rc::Rc;
use std::cell::RefCell;

type Node = Rc<RefCell<TreeNode>>;

struct TreeNode {
    val: i32,
    children: Vec<Node>,
}

fn node(val: i32) -> Node {
    Rc::new(RefCell::new(TreeNode { val, children: vec![] }))
}

fn attach(parent: &Node, child: &Node) {
    parent.borrow_mut().children.push(Rc::clone(child));
}

fn subtree_sum(n: &Node) -> i32 {
    let b = n.borrow();
    let mut s = b.val;
    for c in &b.children {
        s += subtree_sum(c);
    }
    s
}

fn add_to_all(n: &Node, delta: i32) {
    n.borrow_mut().val += delta;
    let children: Vec<Node> = n.borrow().children.iter().map(Rc::clone).collect();
    for c in &children {
        add_to_all(c, delta);
    }
}` },

{ id: 'rs-04-sum-csv-result', lang: 'rust', prompt: `Rust: 用迭代器适配器链 + Result + ? 风格组合解析并求和。定义 enum ParseError { Empty, Bad(String) }(需要能被 assert_eq! 比较与打印)。实现 fn sum_csv(input: &str) -> Result<i64, ParseError>:按逗号分割,每个 token 先 trim,解析为 i64 求和;若整个输入 trim 后为空返回 Err(Empty);任何 token 解析失败返回 Err(Bad(该 trim 后的 token 字符串))。要求用迭代器组合(map + try_fold 之类)实现,不要写显式 for 累加循环。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `assert_eq!(sum_csv(" 1, 2 ,3,  4 "), Ok(10));
assert_eq!(sum_csv("-5,10,-5"), Ok(0));
assert_eq!(sum_csv("42"), Ok(42));
assert_eq!(sum_csv("   "), Err(ParseError::Empty));
assert_eq!(sum_csv(""), Err(ParseError::Empty));
assert_eq!(sum_csv("1,x,3"), Err(ParseError::Bad("x".to_string())));
assert_eq!(sum_csv("1,2,"), Err(ParseError::Bad("".to_string())));`, canonical: `#[derive(Debug, PartialEq)]
enum ParseError {
    Empty,
    Bad(String),
}

fn sum_csv(input: &str) -> Result<i64, ParseError> {
    if input.trim().is_empty() {
        return Err(ParseError::Empty);
    }
    input
        .split(',')
        .map(|tok| {
            let t = tok.trim();
            t.parse::<i64>().map_err(|_| ParseError::Bad(t.to_string()))
        })
        .try_fold(0i64, |acc, r| r.map(|n| acc + n))
}` },

{ id: 'rs-05-group-by-generic', lang: 'rust', prompt: `Rust: 实现一个泛型分组函数,带完整 trait 约束与 FnMut 闭包。签名: fn group_by<I, K, F>(iter: I, key_fn: F) -> std::collections::HashMap<K, Vec<I::Item>> where I: IntoIterator, K: Eq + std::hash::Hash, F: FnMut(&I::Item) -> K。按 key_fn 计算的 key 把元素分组到 HashMap;同一组内保持插入顺序。注意 key_fn 是 FnMut(可能捕获并修改外部状态),所以参数要 mut。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let mut calls = 0;
let groups = group_by(vec![1, 2, 3, 4, 5, 6], |&n| {
    calls += 1;
    n % 2
});
assert_eq!(calls, 6);
assert_eq!(groups.get(&0), Some(&vec![2, 4, 6]));
assert_eq!(groups.get(&1), Some(&vec![1, 3, 5]));

let words = vec!["apple", "banana", "avocado", "cherry", "blueberry"];
let by_first = group_by(words, |s| s.chars().next().unwrap());
assert_eq!(by_first.get(&'a'), Some(&vec!["apple", "avocado"]));
assert_eq!(by_first.get(&'b'), Some(&vec!["banana", "blueberry"]));
assert_eq!(by_first.get(&'c'), Some(&vec!["cherry"]));
assert_eq!(by_first.len(), 3);`, canonical: `use std::collections::HashMap;
use std::hash::Hash;

fn group_by<I, K, F>(iter: I, mut key_fn: F) -> HashMap<K, Vec<I::Item>>
where
    I: IntoIterator,
    K: Eq + Hash,
    F: FnMut(&I::Item) -> K,
{
    let mut map: HashMap<K, Vec<I::Item>> = HashMap::new();
    for item in iter {
        let k = key_fn(&item);
        map.entry(k).or_insert_with(Vec::new).push(item);
    }
    map
}` },

{ id: 'rs-06-lcp-zerocopy', lang: 'rust', prompt: `Rust: 零拷贝最长公共前缀。实现 fn longest_common_prefix<'a>(strs: &'a [&str]) -> &'a str,返回所有字符串的最长公共前缀,且结果必须是【借用第一个字符串】的切片(零拷贝,生命周期与输入绑定)。空切片返回 ""。比较按字节进行,但返回前必须把结束位置回退到合法的 UTF-8 字符边界(多字节字符中途不可切断)。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `assert_eq!(longest_common_prefix(&["flower", "flow", "flight"]), "fl");
assert_eq!(longest_common_prefix(&["dog", "racecar", "car"]), "");
assert_eq!(longest_common_prefix(&["interspecies", "interstellar", "interstate"]), "inters");
assert_eq!(longest_common_prefix(&["alone"]), "alone");
let empty: [&str; 0] = [];
assert_eq!(longest_common_prefix(&empty), "");
assert_eq!(longest_common_prefix(&["caféA", "caféB"]), "café");
assert_eq!(longest_common_prefix(&["cafX", "café"]), "caf");`, canonical: `fn longest_common_prefix<'a>(strs: &'a [&str]) -> &'a str {
    let first = match strs.first() {
        Some(s) => *s,
        None => return "",
    };
    let mut end = first.len();
    for s in &strs[1..] {
        let common = first
            .bytes()
            .zip(s.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        if common < end {
            end = common;
        }
    }
    while end > 0 && !first.is_char_boundary(end) {
        end -= 1;
    }
    &first[..end]
}` },

{ id: 'rs-07-closure-factory', lang: 'rust', prompt: `Rust: 返回捕获可变状态的闭包(闭包工厂)。实现 fn fib_gen() -> impl FnMut() -> u64:每次调用依次返回斐波那契数 0, 1, 1, 2, 3, 5, ...(用 move 捕获两个累加变量,互不共享状态)。再实现 fn accumulator(start: i64) -> impl FnMut(i64) -> i64:返回一个闭包,每次把传入的值累加到内部 total 并返回新的 total(初值为 start)。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let mut f = fib_gen();
let seq: Vec<u64> = (0..10).map(|_| f()).collect();
assert_eq!(seq, vec![0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);

let mut g1 = fib_gen();
let mut g2 = fib_gen();
g1(); g1(); g1();
assert_eq!(g1(), 2);
assert_eq!(g2(), 0);

let mut acc = accumulator(100);
assert_eq!(acc(1), 101);
assert_eq!(acc(2), 103);
assert_eq!(acc(-3), 100);`, canonical: `fn fib_gen() -> impl FnMut() -> u64 {
    let mut a: u64 = 0;
    let mut b: u64 = 1;
    move || {
        let cur = a;
        let next = a + b;
        a = b;
        b = next;
        cur
    }
}

fn accumulator(start: i64) -> impl FnMut(i64) -> i64 {
    let mut total = start;
    move |x| {
        total += x;
        total
    }
}` },

{ id: 'rs-08-dedup-adapter', lang: 'rust', prompt: `Rust: 实现一个泛型惰性迭代器适配器,去除【连续】重复项(consecutive dedup),例如 [1,1,2,2,2,3,1] -> [1,2,3,1]。定义 struct Dedup<I: Iterator> where I::Item: Clone + PartialEq 并为其 impl Iterator(Item 与底层相同)。再实现 fn dedup<I>(iter: I) -> Dedup<I::IntoIter> where I: IntoIterator, <I::IntoIter as Iterator>::Item: Clone + PartialEq。必须保持惰性(可与 take / map 组合,不预先消费整个底层迭代器)。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let v = vec![1, 1, 2, 2, 2, 3, 1, 1];
let got: Vec<i32> = dedup(v).collect();
assert_eq!(got, vec![1, 2, 3, 1]);

let got2: Vec<i32> = dedup(vec![5, 5, 5, 5]).map(|x| x * 2).collect();
assert_eq!(got2, vec![10]);

let e: Vec<i32> = dedup(Vec::<i32>::new()).collect();
assert_eq!(e, Vec::<i32>::new());

let s = "aaabccdda";
let got3: String = dedup(s.chars()).collect();
assert_eq!(got3, "abcda");

let first_two: Vec<i32> = dedup(vec![9, 9, 8, 8, 7, 7]).take(2).collect();
assert_eq!(first_two, vec![9, 8]);`, canonical: `struct Dedup<I: Iterator>
where
    I::Item: Clone + PartialEq,
{
    inner: I,
    last: Option<I::Item>,
}

impl<I: Iterator> Iterator for Dedup<I>
where
    I::Item: Clone + PartialEq,
{
    type Item = I::Item;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            match self.inner.next() {
                None => return None,
                Some(x) => {
                    if self.last.as_ref() == Some(&x) {
                        continue;
                    }
                    self.last = Some(x.clone());
                    return Some(x);
                }
            }
        }
    }
}

fn dedup<I>(iter: I) -> Dedup<I::IntoIter>
where
    I: IntoIterator,
    <I::IntoIter as Iterator>::Item: Clone + PartialEq,
{
    Dedup { inner: iter.into_iter(), last: None }
}` },

{ id: 'rs-09-zerocopy-lexer', lang: 'rust', prompt: `Rust: 写一个零拷贝词法分析器,返回的 token 借用输入字符串的切片。定义 enum Token<'a> { Ident(&'a str), Number(&'a str), Op(char) }(可被 assert_eq! 比较/打印)。实现 fn tokenize<'a>(src: &'a str) -> Vec<Token<'a>>:Ident = ascii 字母或下划线开头、后接字母/数字/下划线的连续串;Number = 连续 ascii 数字;Op = 单字符 + - * / ( ) 之一;空白跳过;其它任何字符静默跳过。Ident/Number 必须用 &src[..] 子切片(零拷贝),不得 to_string。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let toks = tokenize("foo + bar_2 * 42");
assert_eq!(
    toks,
    vec![
        Token::Ident("foo"),
        Token::Op('+'),
        Token::Ident("bar_2"),
        Token::Op('*'),
        Token::Number("42"),
    ]
);

let toks2 = tokenize("(a1+ b )/10");
assert_eq!(
    toks2,
    vec![
        Token::Op('('),
        Token::Ident("a1"),
        Token::Op('+'),
        Token::Ident("b"),
        Token::Op(')'),
        Token::Op('/'),
        Token::Number("10"),
    ]
);

let toks3 = tokenize("x # 7 @y");
assert_eq!(
    toks3,
    vec![Token::Ident("x"), Token::Number("7"), Token::Ident("y")]
);

assert_eq!(tokenize("   "), vec![]);

let src = String::from("hello42");
let toks4 = tokenize(&src);
if let Token::Ident(s) = toks4[0] {
    assert_eq!(s.as_ptr(), src.as_ptr());
} else {
    panic!("expected ident");
}`, canonical: `#[derive(Debug, PartialEq)]
enum Token<'a> {
    Ident(&'a str),
    Number(&'a str),
    Op(char),
}

fn tokenize<'a>(src: &'a str) -> Vec<Token<'a>> {
    let bytes = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            out.push(Token::Ident(&src[start..i]));
        } else if c.is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            out.push(Token::Number(&src[start..i]));
        } else if matches!(c, b'+' | b'-' | b'*' | b'/' | b'(' | b')') {
            out.push(Token::Op(c as char));
            i += 1;
        } else {
            i += 1;
        }
    }
    out
}` },

{ id: 'rs-10-generic-mat2-ops', lang: 'rust', prompt: `Rust: 泛型 2x2 矩阵 + 运算符重载 + 快速幂。定义 #[derive(Debug, Clone, Copy, PartialEq)] struct Mat2<T>,行主序字段 a,b,c,d(分别是 [[a,b],[c,d]]),并提供 fn new(a:T,b:T,c:T,d:T)->Self。为 Mat2<T> impl std::ops::Add(逐元素相加,约束 T: Add<Output=T> + Copy)与 std::ops::Mul(2x2 矩阵乘法,约束 T: Add<Output=T> + Mul<Output=T> + Copy)。再实现 fn mat_pow<T>(base: Mat2<T>, exp: u64, identity: Mat2<T>) -> Mat2<T>(同样约束),用二进制快速幂、复用 Mul 实现。无 main。只返回代码(无 main),用 \`\`\`rust 包裹,不要解释。`, test: `let id = Mat2::new(1i64, 0, 0, 1);
let m = Mat2::new(1i64, 1, 1, 0);

assert_eq!(mat_pow(m, 1, id), Mat2::new(1, 1, 1, 0));
assert_eq!(mat_pow(m, 2, id), Mat2::new(2, 1, 1, 1));
assert_eq!(mat_pow(m, 0, id), id);
assert_eq!(mat_pow(m, 10, id).a, 89);

let p = Mat2::new(1i64, 2, 3, 4) + Mat2::new(10, 20, 30, 40);
assert_eq!(p, Mat2::new(11, 22, 33, 44));

let q = Mat2::new(1i64, 2, 3, 4) * Mat2::new(5, 6, 7, 8);
assert_eq!(q, Mat2::new(19, 22, 43, 50));

let mf = Mat2::new(2.0f64, 0.0, 0.0, 3.0);
let idf = Mat2::new(1.0f64, 0.0, 0.0, 1.0);
assert_eq!(mat_pow(mf, 3, idf), Mat2::new(8.0, 0.0, 0.0, 27.0));`, canonical: `use std::ops::{Add, Mul};

#[derive(Debug, Clone, Copy, PartialEq)]
struct Mat2<T> {
    a: T,
    b: T,
    c: T,
    d: T,
}

impl<T> Mat2<T> {
    fn new(a: T, b: T, c: T, d: T) -> Self {
        Mat2 { a, b, c, d }
    }
}

impl<T> Add for Mat2<T>
where
    T: Add<Output = T> + Copy,
{
    type Output = Mat2<T>;
    fn add(self, rhs: Mat2<T>) -> Mat2<T> {
        Mat2::new(
            self.a + rhs.a,
            self.b + rhs.b,
            self.c + rhs.c,
            self.d + rhs.d,
        )
    }
}

impl<T> Mul for Mat2<T>
where
    T: Add<Output = T> + Mul<Output = T> + Copy,
{
    type Output = Mat2<T>;
    fn mul(self, rhs: Mat2<T>) -> Mat2<T> {
        Mat2::new(
            self.a * rhs.a + self.b * rhs.c,
            self.a * rhs.b + self.b * rhs.d,
            self.c * rhs.a + self.d * rhs.c,
            self.c * rhs.b + self.d * rhs.d,
        )
    }
}

fn mat_pow<T>(base: Mat2<T>, mut exp: u64, identity: Mat2<T>) -> Mat2<T>
where
    T: Add<Output = T> + Mul<Output = T> + Copy,
{
    let mut result = identity;
    let mut b = base;
    while exp > 0 {
        if exp & 1 == 1 {
            result = result * b;
        }
        b = b * b;
        exp >>= 1;
    }
    result
}` }
];
