const html = require('choo/html');
const assets = require('../../common/assets');

module.exports = function(state) {
  const btnText = state.user.loggedIn ? 'okButton' : 'sendYourFilesLink';
  return html`
    <div
      id="download-complete"
      class="flex flex-col items-center justify-center h-full w-full bg-white p-2 dark:bg-grey-90"
    >
      <h1 class="text-center text-3xl font-bold my-2">
        ${state.translate('downloadFinish')}
      </h1>
      <svg class="my-8 h-48 text-primary">
        <use xlink:href="${assets.get('completed.svg')}#Page-1" />
      </svg>
    </div>
  `;
};
