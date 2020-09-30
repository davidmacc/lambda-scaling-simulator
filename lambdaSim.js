let lambdaChart;

function runLambdaSim() {
  setHtml("status", "Executing...");
  setTimeout(execSimulation, 0);
}

function execSimulation() {
  const START = new Date();
  const TARGET_RPS = getInt("TARGET_RPS");
  const RAMPUP_PERIOD_SEC = getInt("RAMPUP_PERIOD_SEC");
  const COLD_START_DURATION_MS = getInt("COLD_START_DURATION_MS");
  const WARM_START_DURATION_MS = getInt("WARM_START_DURATION_MS");
  const MAX_CONCURRENCY_LIMIT = getInt("CONCURRENCY_LIMIT");
  const INITIAL_WARM_CONTAINERS = getInt("INITIAL_WARM_CONTAINERS");
  const SIM_DURATION_SEC = getInt("SIM_DURATION_SEC");
  const BURST_CONCURRENCY_QUOTA = getSelectValInt("AWS_REGION");
  const POST_BURST_CONCURRENCY_SCALE_PER_MIN = 500;
  const RPS_LIMIT = 10 * MAX_CONCURRENCY_LIMIT;

  let pendingInvocations = [];
  let warmContainers = INITIAL_WARM_CONTAINERS;
  let usableConcurrency = Math.min(BURST_CONCURRENCY_QUOTA, MAX_CONCURRENCY_LIMIT);
  let burstConcurrencyQuotaBreached = false;

  let seriesTimeSec = [0];
  let seriesInvocationsRequested = [0];
  let seriesInvocationsStarted = [0];
  let seriesInvocationsCompleted = [0];
  let seriesMaxConcurrency = [0];
  let seriesUsableConcurrency = [usableConcurrency];
  let seriesConcurrencyLimit = [MAX_CONCURRENCY_LIMIT];
  let seriesColdStarts = [0];
  let seriesWarmStarts = [0];
  let seriesThrottles = [0];
  let seriesWarmContainers = [warmContainers];

  // {Loop: Seconds}
  for (sec = 0; sec < SIM_DURATION_SEC; sec++) {

    let invocationsAttempted = 0;
    let invocationsStarted = 0;
    let coldStarts = 0;
    let warmStarts = 0;
    let maxConcurrency = 0;
    let invocationsCompleted = 0;
    let throttles = 0;
    let lastInvokeTimeMs = 0;

    // Calculate requests to invoke in current second, and interval (ms)
    const TARGET_REQUESTS = sec < RAMPUP_PERIOD_SEC ?
      (TARGET_RPS / RAMPUP_PERIOD_SEC) * (sec + 1) : TARGET_RPS;
    const REQUEST_INTERVAL_MS = (1 / TARGET_REQUESTS) * 1000;

    // {Loop: Milliseconds}
    for (ms = 0; ms < 1000; ms++) {

      currentTimeMs = (sec * 1000) + ms;

      // 'Complete' pending invocations
      while (pendingInvocations.length > 0 && pendingInvocations[0].endTimeMs == currentTimeMs) {
        pendingInvocations.shift();
        invocationsCompleted++;
      }

      // Determine how many invocations we should execute for this millisecond
      let numToInvoke = 0;
      if (invocationsAttempted == 0) {
        numToInvoke = Math.max(1, Math.floor(1 / REQUEST_INTERVAL_MS));
      }
      else {
        let timeSinceLastInvokeMs = ms - lastInvokeTimeMs;
        if (timeSinceLastInvokeMs >= REQUEST_INTERVAL_MS) {
          numToInvoke = Math.floor(timeSinceLastInvokeMs / REQUEST_INTERVAL_MS);
          // Bump up invocations by 1 if short (due to rounding)
          if (ms == 999 && invocationsStarted + numToInvoke < TARGET_REQUESTS) numToInvoke++;
          lastInvokeTimeMs += REQUEST_INTERVAL_MS * numToInvoke;
        }
      }

      if (burstConcurrencyQuotaBreached)
        usableConcurrency = Math.min(usableConcurrency +
          (POST_BURST_CONCURRENCY_SCALE_PER_MIN / (60 * 1000)), MAX_CONCURRENCY_LIMIT);

      // 'Execute' invocations
      for (n = 1; n <= numToInvoke; n++) {
        invocationsAttempted++;
        concurrency = pendingInvocations.length;

        if (concurrency == Math.floor(usableConcurrency) || invocationsAttempted >= RPS_LIMIT) {
          throttles++;
          continue;
        }

        const IS_COLD_START = !(concurrency < warmContainers);
        endTimeMs = currentTimeMs +
          (IS_COLD_START ? COLD_START_DURATION_MS : WARM_START_DURATION_MS);
        if (IS_COLD_START) {
          coldStarts++;
          warmContainers++;
        }

        // Insert into pending invocation array in scheduled completion time order
        let pos = 0;
        for (; pos < pendingInvocations.length; pos++)
          if (pendingInvocations[pos].endTimeMs > endTimeMs)
            break;

        pendingInvocations.splice(pos, 0, { 'endTimeMs': endTimeMs });
        invocationsStarted++;
        concurrency++;

        if (concurrency == BURST_CONCURRENCY_QUOTA)
          burstConcurrencyQuotaBreached = true;
      }
      maxConcurrency = Math.max(maxConcurrency, concurrency);
    }
    warmStarts = invocationsStarted - coldStarts;

    seriesTimeSec.push(sec + 1);
    seriesInvocationsRequested.push(invocationsAttempted);
    seriesInvocationsStarted.push(invocationsStarted);
    seriesInvocationsCompleted.push(invocationsCompleted);
    seriesColdStarts.push(coldStarts);
    seriesWarmStarts.push(warmStarts);
    seriesMaxConcurrency.push(maxConcurrency);
    seriesUsableConcurrency.push(Math.floor(usableConcurrency));
    seriesThrottles.push(throttles);
    seriesWarmContainers.push(warmContainers);
    seriesConcurrencyLimit.push(MAX_CONCURRENCY_LIMIT);
  }

  // Calc summary data

  const SUM_INVOCATIONS_REQUESTED = sumArray(seriesInvocationsRequested);
  const SUM_INVOCATIONS_STARTED = sumArray(seriesInvocationsStarted);
  const PCT_INVOCATIONS_STARTED = (100 * SUM_INVOCATIONS_STARTED / SUM_INVOCATIONS_REQUESTED).toFixed(2);
  const SUM_COLD_STARTS = sumArray(seriesColdStarts);
  const SUM_WARM_STARTS = sumArray(seriesWarmStarts);
  const PCT_COLD_STARTS = (100 * SUM_COLD_STARTS / SUM_INVOCATIONS_STARTED).toFixed(2);
  const PCT_WARM_STARTS = (100 * SUM_WARM_STARTS / SUM_INVOCATIONS_STARTED).toFixed(2);
  const SUM_THROTTLES = sumArray(seriesThrottles);
  const PCT_THROTTLES = (SUM_THROTTLES == 0 ?
    0 : (100 * SUM_THROTTLES / SUM_INVOCATIONS_REQUESTED)).toFixed(2);
  const MAX_CONCURRENCY = maxArray(seriesMaxConcurrency);
  const AVG_DURATION = (((SUM_COLD_STARTS * COLD_START_DURATION_MS) +
    (SUM_WARM_STARTS * WARM_START_DURATION_MS)) / SUM_INVOCATIONS_STARTED).toFixed(0);

  setHtml("summarySimDuration", SIM_DURATION_SEC + " sec");
  setHtml("summaryInvocationsRequested", SUM_INVOCATIONS_REQUESTED);
  setHtml("summaryInvocationsStarted", SUM_INVOCATIONS_STARTED);
  setHtml("summaryInvocationsStartedPct", "(" + PCT_INVOCATIONS_STARTED + "%)");
  setHtml("summaryInvocationsStartedCold", SUM_COLD_STARTS);
  setHtml("summaryInvocationsStartedColdPct", "(" + PCT_COLD_STARTS + "%)");
  setHtml("summaryInvocationsStartedWarm", SUM_WARM_STARTS);
  setHtml("summaryInvocationsStartedWarmPct", "(" + PCT_WARM_STARTS + "%)");
  setHtml("summaryInvocationsThrottled", SUM_THROTTLES);
  setHtml("summaryInvocationsThrottledPct", "(" + PCT_THROTTLES + "%)");
  setHtml("summaryConcurrencyMax", MAX_CONCURRENCY);
  setHtml("summaryAvgDuration", AVG_DURATION);

  // Render chart 

  let chartData = {
    labels: seriesTimeSec,
    datasets: [
      {
        label: 'Invocations Requested',
        data: seriesInvocationsRequested,
        borderColor: "#8a765f",
        fill: false,
        hidden: true
      },
      {
        label: 'Invocations Started',
        data: seriesInvocationsStarted,
        borderColor: "#3e95cd",
        fill: false
      },
      {
        label: 'Invocations Started (Cold)',
        data: seriesColdStarts,
        borderColor: "#3e8e72",
        fill: false
      },
      {
        label: 'Invocations Started (Warm)',
        data: seriesWarmStarts,
        borderColor: "#6cbc1f",
        fill: false
      },
      {
        label: 'Invocations Completed',
        data: seriesInvocationsCompleted,
        borderColor: "#8e5ea2",
        fill: false
      },
      {
        label: 'Concurrency Limit',
        data: seriesConcurrencyLimit,
        borderColor: "#a8c3cf",
        fill: false,
        hidden: true
      },
      {
        label: 'Addressable Concurrency (Burst)',
        data: seriesUsableConcurrency,
        borderColor: "#cdd188",
        fill: false,
        hidden: true
      },
      {
        label: 'Concurrency',
        data: seriesMaxConcurrency,
        borderColor: "#e8c3b9",
        fill: false
      },
      {
        label: 'Provisioned/Warmed Instances',
        data: seriesWarmContainers,
        borderColor: "#c8a3c9",
        fill: false
      },
      {
        label: 'Throttles',
        data: seriesThrottles,
        borderColor: "#ff23b1",
        fill: false
      }
    ]
  };

  renderChart(chartData);

  const END = new Date();
  const SIM_TIME = END - START;
  setHtml("status", "[Completed in " + SIM_TIME / 1000 + " sec]");
}

function renderChart(chartData) {
  Chart.defaults.global.defaultFontSize = 14;
  Chart.defaults.global.defaultFontColor = '#444';

  const chartOptions =
  {
    animation: {
      duration: 0,
    },
    legend: {
      position: "right",
      align: "left"
    },
    scales: {
      yAxes: [{
        ticks: {
          suggestedMin: 0
        }
      }],
      xAxes: [{
        scaleLabel: {
          display: true,
          labelString: 'Time (sec)'
        }
      }],
    },
    elements: {
      line: {
        // tension: 0.2
      }
    }
  };

  if (lambdaChart == null) {
    let ctx = document.getElementById("lambdaChart").getContext('2d');
    lambdaChart = new Chart(ctx, {
      type: 'line',
      options: chartOptions,
      data: chartData
    });
  }
  else {
    lambdaChart.data = chartData;
    lambdaChart.update();
  }
}

function rampUpPeriodUpdated(obj) {
  let rampUpPeriod = parseInt(obj.value);
  document.getElementById("SIM_DURATION_SEC").value = Math.max(rampUpPeriod * 2, 10);
}

function awsRegionUpdated(obj) {
  var value = obj.value;
  document.getElementById("BURST_CONCURRENCY_QUOTA").value = value;
}

function sumArray(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function maxArray(arr) {
  return Math.max.apply(null, arr);
}

function setHtml(id, innerHtml) {
  document.getElementById(id).innerHTML = innerHtml;
}

function getInt(elementId) {
  return parseInt(document.getElementById(elementId).value);
}

function getSelectValInt(elementId) {
  return parseInt(document.getElementById(elementId).options[document.getElementById(elementId).selectedIndex].value);
}

runLambdaSim();