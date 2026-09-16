TEX  = pdflatex
MAIN = main

.PHONY: all figures clean

all: $(MAIN).pdf

$(MAIN).pdf: $(MAIN).tex $(wildcard figures/*.pdf)
	$(TEX) -interaction=nonstopmode $(MAIN).tex
	$(TEX) -interaction=nonstopmode $(MAIN).tex

# Regenerate every data figure and the architecture diagram from the raw
# result files (run from anywhere; paths are resolved relative to the repo).
figures:
	python figures/build_figures.py
	python figures/build_system.py

clean:
	rm -f *.aux *.log *.out *.bbl *.blg
