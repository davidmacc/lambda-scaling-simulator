let chart;
const chartSeriesToggles = [0, 1, 1, 1, 1, 0, 0, 1, 1, 1];

function runLambdaSim() {
  setHtml('status', 'Executing...');
  setTimeout(execSimulation, 0);
}

function execSimulation() {
  const startTime = new Date();
  const targetRPS = getInt('targetRPS');
  const rampupPeriodSec = getInt('rampupPeriodSec');
  const coldStartDurationMs = getInt('coldStartDurationMs');
  const warmStartDurationMs = getInt('warmStartDurationMs');
  const maxConcurrencyLimit = getInt('concurrencyLimit');
  const initialWarmContainers = getInt('initialWarmContainers');
  const simDurationSec = getInt('simDurationSec');
  const burstConcurrencyQuota = getSelectValInt('awsRegion');
  const POST_BURST_CONCURRENCY_SCALE_PER_MIN = 500;

  const pendingInvocations = [];
  let warmContainers = initialWarmContainers;
  let usableConcurrency = Math.max(
    Math.min(burstConcurrencyQuota, maxConcurrencyLimit), initialWarmContainers);
  let burstConcurrencyQuotaBreached = false;
  
  const seriesTimeSec = [0];
  const seriesInvocationsRequested = [0];
  const seriesInvocationsStarted = [0];
  const seriesInvocationsCompleted = [0];
  const seriesMaxConcurrency = [0];
  const seriesUsableConcurrency = [usableConcurrency];
  const seriesConcurrencyLimit = [maxConcurrencyLimit];
  const seriesColdStarts = [0];
  const seriesWarmStarts = [0];
  const seriesThrottles = [0];
  const seriesWarmContainers = [warmContainers];

  // {Loop: Seconds}
  for (sec = 0; sec < simDurationSec; sec++) {

    let invocationsAttempted = 0;
    let invocationsStarted = 0;
    let coldStarts = 0;
    let warmStarts = 0;
    let maxConcurrency = 0;
    let invocationsCompleted = 0;
    let throttles = 0;
    let lastInvokeTimeMs = 0;

    // Calculate requests to invoke in current second, and interval (ms)
    const targetRequests = sec < rampupPeriodSec ?
      (targetRPS / rampupPeriodSec) * (sec + 1) : targetRPS;
    const requestIntervalMs = (1 / targetRequests) * 1000;

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
        numToInvoke = Math.max(1, Math.floor(1 / requestIntervalMs));
      }
      else {
        let timeSinceLastInvokeMs = ms - lastInvokeTimeMs;
        if (timeSinceLastInvokeMs >= requestIntervalMs) {
          numToInvoke = Math.floor(timeSinceLastInvokeMs / requestIntervalMs);
          // Bump up invocations by 1 if short (due to rounding)
          if (ms == 999 && invocationsStarted + numToInvoke < targetRequests) numToInvoke++;
          lastInvokeTimeMs += requestIntervalMs * numToInvoke;
        }
      }

      if (burstConcurrencyQuotaBreached)
        usableConcurrency = Math.min(usableConcurrency +
          (POST_BURST_CONCURRENCY_SCALE_PER_MIN / (60 * 1000)), maxConcurrencyLimit);

      // 'Execute' invocations
      for (n = 1; n <= numToInvoke; n++) {
        invocationsAttempted++;
        concurrency = pendingInvocations.length;

        if (concurrency == Math.floor(usableConcurrency)) {
          throttles++;
          continue;
        }

        const isColdStart = !(concurrency < warmContainers);
        endTimeMs = currentTimeMs + (isColdStart ? coldStartDurationMs : warmStartDurationMs);
        if (isColdStart) {
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

        if (concurrency == Math.max(burstConcurrencyQuota, initialWarmContainers))
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
    seriesConcurrencyLimit.push(maxConcurrencyLimit);
  }

  // Calc summary data

  const sumInvocationsRequested = sumArray(seriesInvocationsRequested);
  const sumInvocationsStarted = sumArray(seriesInvocationsStarted);
  const pctInvocationsStarted = (100 * sumInvocationsStarted / sumInvocationsRequested).toFixed(2);
  const sumColdStarts = sumArray(seriesColdStarts);
  const sumWarmStarts = sumArray(seriesWarmStarts);
  const pctColdStarts = (100 * sumColdStarts / sumInvocationsStarted).toFixed(2);
  const pctWarmStarts = (100 * sumWarmStarts / sumInvocationsStarted).toFixed(2);
  const sumThrottles = sumArray(seriesThrottles);
  const pctThrottles = (sumThrottles == 0 ?
    0 : (100 * sumThrottles / sumInvocationsRequested)).toFixed(2);
  const maxConcurrency = maxArray(seriesMaxConcurrency);
  const avgDuration = (((sumColdStarts * coldStartDurationMs) +
    (sumWarmStarts * warmStartDurationMs)) / sumInvocationsStarted).toFixed(0);

  setHtml('summarySimDuration', numWithCommas(simDurationSec) + ' sec');
  setHtml('summaryInvocationsRequested', numWithCommas(sumInvocationsRequested));
  setHtml('summaryInvocationsStarted', numWithCommas(sumInvocationsStarted));
  setHtml('summaryInvocationsStartedPct', `(${pctInvocationsStarted}%)`);
  setHtml('summaryInvocationsStartedCold', numWithCommas(sumColdStarts));
  setHtml('summaryInvocationsStartedColdPct', `(${pctColdStarts}%)`);
  setHtml('summaryInvocationsStartedWarm', numWithCommas(sumWarmStarts));
  setHtml('summaryInvocationsStartedWarmPct', `(${pctWarmStarts}%)`);
  setHtml('summaryInvocationsThrottled', numWithCommas(sumThrottles));
  setHtml('summaryInvocationsThrottledPct', `(${pctThrottles}%)`);
  setHtml('summaryConcurrencyMax', maxConcurrency);
  setHtml('summaryAvgDuration', avgDuration + ' ms');

  // Render chart 

  if (chart) {
    chartSeriesToggles.forEach((elem, i, arr) => arr[i] = chart.isDatasetVisible(i));
  }

  const chartData = {
    labels: seriesTimeSec,
    datasets: [
      {
        label: 'Invocations Requested',
        data: seriesInvocationsRequested,
        borderColor: '#8a765f',
        fill: false,
        hidden: !chartSeriesToggles[0]
      },
      {
        label: 'Invocations Started',
        data: seriesInvocationsStarted,
        borderColor: '#3e95cd',
        fill: false,
        hidden: !chartSeriesToggles[1]
      },
      {
        label: 'Invocations Started (Cold)',
        data: seriesColdStarts,
        borderColor: '#3e8e72',
        fill: false,
        hidden: !chartSeriesToggles[2]
      },
      {
        label: 'Invocations Started (Warm)',
        data: seriesWarmStarts,
        borderColor: '#6cbc1f',
        fill: false,
        hidden: !chartSeriesToggles[3]
      },
      {
        label: 'Invocations Completed',
        data: seriesInvocationsCompleted,
        borderColor: '#8e5ea2',
        fill: false,
        hidden: !chartSeriesToggles[4]
      },
      {
        label: 'Concurrency Limit',
        data: seriesConcurrencyLimit,
        borderColor: '#a8c3cf',
        fill: false,
        hidden: !chartSeriesToggles[5]
      },
      {
        label: 'Addressable Concurrency (Burst)',
        data: seriesUsableConcurrency,
        borderColor: '#cdd188',
        fill: false,
        hidden: !chartSeriesToggles[6]
      },
      {
        label: 'Concurrency',
        data: seriesMaxConcurrency,
        borderColor: '#e8c3b9',
        fill: false,
        hidden: !chartSeriesToggles[7]
      },
      {
        label: 'Provisioned/Warmed Instances',
        data: seriesWarmContainers,
        borderColor: '#c8a3c9',
        fill: false,
        hidden: !chartSeriesToggles[8]
      },
      {
        label: 'Throttles',
        data: seriesThrottles,
        borderColor: '#ff23b1',
        fill: false,
        hidden: !chartSeriesToggles[9]
      }
    ]
  };

  renderChart(chartData);

  const endTime = new Date();
  const duration = endTime - startTime;
  setHtml('status', `[Completed in ${duration / 1000} sec]`);
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
      position: 'right',
      align: 'left'
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
        //tension: 0.3
      }
    }
  };

  if (chart == null) {
    let ctx = document.getElementById('lambdaChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      options: chartOptions,
      data: chartData
    });
  }
  else {
    chart.data = chartData;
    chart.update();
  }
}

function rampUpPeriodUpdated(obj) {
  let rampUpPeriod = parseInt(obj.value);
  document.getElementById('simDurationSec').value = Math.max(rampUpPeriod * 2, 10);
}

function awsRegionUpdated(obj) {
  var value = obj.value;
  document.getElementById('burstConcurrencyQuota').value = value;
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

function numWithCommas(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

runLambdaSim();