use crate::TractResult;
use egglog::ast::{
    Expr, GenericCommand, GenericExpr, GenericRunConfig, GenericSchedule, Literal, DUMMY_SPAN,
};
use egglog::EGraph;

use super::{SymbolScope, TDim, ToDim};

static TDIM_EGGLOG: &str = include_str!("../../egglog/tdim.egglog");

fn get_engine() -> EGraph {
    let mut graph = EGraph::default();
    let _ = graph.parse_and_run_program(Some("tdim.egglog".into()), &TDIM_EGGLOG).unwrap();
    graph
}

pub fn simplify(scope: &SymbolScope, src: &TDim) -> TractResult<TDim> {
    let expr = tdim_to_expr(src);
    let mut egraph = get_engine();
    let (_, value) = egraph.eval_expr(&expr).unwrap();
    egraph
        .run_program(vec![GenericCommand::RunSchedule(GenericSchedule::Repeat(
            DUMMY_SPAN.clone(),
            10,
            Box::new(GenericSchedule::Run(
                DUMMY_SPAN.clone(),
                GenericRunConfig { ruleset: "".into(), until: None },
            )),
        ))])
        .unwrap();
    let (dag, it) = egraph.extract_value(value);
    let simplified = dag.term_to_expr(&it);
    Ok(expr_to_tdim(&scope, &simplified))
}

fn lit(x: i64) -> Expr {
    Expr::lit_no_span(Literal::Int(x))
}

fn tdim_to_expr(tdim: &TDim) -> Expr {
    match tdim {
        TDim::Val(x) => Expr::call_no_span("Num", [lit(*x)]),
        TDim::Sym(s) => {
            Expr::call_no_span("Var", [Expr::lit_no_span(Literal::String(s.to_string().into()))])
        }
        TDim::Add(terms) => {
            terms.iter().map(tdim_to_expr).reduce(|a, b| Expr::call_no_span("Add", [a, b])).unwrap()
        }
        TDim::Mul(terms) => terms
            .iter()
            .map(tdim_to_expr)
            .reduce(|a, b| Expr::call_no_span("Mul", [a, b]))
            .unwrap_or_else(|| tdim_to_expr(&1.to_dim())),
        TDim::MulInt(a, b) => {
            Expr::call_no_span("Mul", [tdim_to_expr(&a.to_dim()), tdim_to_expr(b)])
        }
        TDim::Div(p, q) => Expr::call_no_span("Div", [tdim_to_expr(p), lit(*q as i64)]),
        _ => todo!("{tdim:?}"),
    }
}

fn expr_to_tdim(scope: &SymbolScope, expr: &Expr) -> TDim {
    match expr {
        GenericExpr::Call(_, s, children) if s.as_str() == "Add" => {
            let left = expr_to_tdim(scope, &children[0]);
            let right = expr_to_tdim(scope, &children[1]);
            TDim::Add(vec![left, right])
        }
        GenericExpr::Call(_, s, children) if s.as_str() == "Mul" => {
            let left = expr_to_tdim(scope, &children[0]);
            let right = expr_to_tdim(scope, &children[1]);
            if let Some(l) = left.as_i64() {
                TDim::MulInt(l, Box::new(right))
            } else if let Some(r) = right.as_i64() {
                TDim::MulInt(r, Box::new(left))
            } else {
                TDim::Mul(vec![left, right])
            }
        }
        GenericExpr::Call(_, s, children) if s.as_str() == "Num" => {
            expr_to_tdim(scope, &children[0])
        }
        GenericExpr::Call(_, s, children) if s.as_str() == "Var" => {
            expr_to_tdim(scope, &children[0])
        }
        GenericExpr::Call(_, s, children) if s.as_str() == "Div" => {
            let p = expr_to_tdim(scope, &children[0]);
            let GenericExpr::Lit(_, Literal::Int(q)) = &children[1] else { unreachable!() };
            assert!(*q > 0);
            TDim::Div(Box::new(p), *q as u64)
        }
        GenericExpr::Lit(_, Literal::Int(i)) => i.to_dim(),
        GenericExpr::Lit(_, Literal::String(i)) => scope.sym(i.as_str()).to_dim(),
        _ => todo!("{expr}"),
    }
}
