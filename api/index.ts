import { handleCloudRequest } from '../server/cloud/handler.js';

export default {
  fetch(request: Request) { return handleCloudRequest(request); },
};
