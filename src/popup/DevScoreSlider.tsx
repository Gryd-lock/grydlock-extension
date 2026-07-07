interface DevScoreSliderProps {
  score: number
  onChange: (score: number) => void
}

export default function DevScoreSlider({ score, onChange }: DevScoreSliderProps) {
  return (
    <div className="dev-slider">
      <label htmlFor="dev-score">Dev: override score ({score})</label>
      <input
        id="dev-score"
        type="range"
        min={0}
        max={100}
        value={score}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
